using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using UnderwritingOrchestrator.Agents;
using UnderwritingOrchestrator.Cases;
using UnderwritingOrchestrator.Dependencies;
using Microsoft.Extensions.Options;
using static UnderwritingOrchestrator.Cases.StepCatalog;

namespace UnderwritingOrchestrator.Underwriting;

/// <summary>Everything known about the company so far, and the advisor's review, handed to the analyses.</summary>
public sealed record CaseFacts(string Siren)
{
    public JsonNode? Customer { get; init; }
    public JsonNode? Identity { get; init; }
    public JsonNode? LegalEvents { get; init; }
    public JsonNode? Financials { get; init; }
    public JsonNode? OpenItems { get; init; }
    public JsonNode? DataQuality { get; init; }
    public DataReview? AdvisorReview { get; init; }
}

/// <summary>
/// The underwriting journey. Each step starts as soon as the steps it depends on are done (StepCatalog.dependsOn),
/// not phase after phase. The advisor is at its heart: they validate the collected data, which holds up the
/// financial-health analysis and the synthesis only, and they take the decision. LLM steps share two slots.
/// The climate agent fetches the natural risks itself: the model calls the Géorisques tool, served by reShapr (MCP).
/// </summary>
public sealed class UnderwritingWorkflow(
    CompanyDataApis services, ToolUsingAgent toolUsingAgent, IOptions<GeorisquesMcpOptions> georisquesMcp,
    LlmGatewayClient llm, StepRunner steps, ILogger<UnderwritingWorkflow> log)
{
    private const string NoLlmReason = "Non exécutée : procédure collective, aucun LLM appelé.";
    private readonly ConcurrentDictionary<string, Task<JsonNode?>> _steps = new();

    public void Start(UnderwritingCase underwritingCase, CancellationToken ct) => _ = Task.Run(async () =>
    {
        try { await RunAsync(underwritingCase, ct); }
        catch (OperationCanceledException) { log.LogInformation("{CaseId} replaced or stopped", underwritingCase.CaseId); }
        catch (Exception e) { log.LogError(e, "{CaseId} stopped", underwritingCase.CaseId); }
    }, ct);

    private async Task RunAsync(UnderwritingCase c, CancellationToken ct)
    {
        var customerNotFound = false;
        Schedule(c, CheckAccount, ct, async calls =>
        {
            var account = await services.FindCustomerAsync(c.Siren, calls, ct);
            customerNotFound = account is null;
            return account is null
                ? new StepOutcome(StepSummaries.CustomerNotFound(c.Siren), new JsonObject
                {
                    ["code"] = "CUSTOMER_NOT_FOUND", ["message"] = $"Aucun compte client pour le SIREN {c.Siren}.",
                })
                : new StepOutcome(StepSummaries.CustomerFound(account), account);
        });
        var customer = await _steps[CheckAccount];
        if (customerNotFound || customer?["customerId"] is null)
        {
            var reason = customerNotFound ? "Non exécutée : compte client introuvable." : "Non exécutée : compte client non vérifié.";
            foreach (var stepId in Order.Where(id => id != StepCatalog.AdvisorDecision)) StepRunner.Skip(c, stepId, reason);
            c.Update(x => x.Steps[Synthesis].Kind = StepKind.Rule);
            WaitForDecision(c, customerNotFound ? UnderwritingRules.NotEligible(c.Siren) : UnderwritingRules.CustomerAccountUnavailable());
            return;
        }
        c.Update(x => x.CompanyName = customer["name"]?.ToString());

        Schedule(c, CompanyIdentity, ct, async calls =>
        {
            var company = await services.GetCompanyIdentityAsync(c.Siren, calls, ct);
            c.Update(x => x.CompanyName = company["denomination"]?.ToString() ?? x.CompanyName);
            return new StepOutcome(StepSummaries.CompanyIdentity(company), company);
        });
        Schedule(c, LegalEvents, ct, async calls =>
        {
            var announcements = await services.GetLegalAnnouncementsAsync(c.Siren, calls, ct);
            var procedure = UnderwritingRules.FindCollectiveProcedure(announcements);
            return new StepOutcome(StepSummaries.LegalEvents(announcements, procedure), announcements);
        });
        Schedule(c, Financials, ct, async calls =>
        {
            var balanceSheet = await services.GetFinancialsAsync(c.Siren, calls, ct);
            return new StepOutcome(StepSummaries.Financials(balanceSheet), balanceSheet);
        });
        Schedule(c, OpenItems, ct, async calls =>
        {
            var items = await services.GetOpenItemsAsync(customer["customerId"]!.ToString(), calls, ct);
            return new StepOutcome(StepSummaries.OpenItems(items), items);
        });
        Analyse(c, DataQuality, () => AgentPrompts.DataQuality(Facts(c)), StepSummaries.DataQuality, ct);
        _steps[StepCatalog.DataReview] = AfterDependencies(StepCatalog.DataReview, () => WaitForDataReviewAsync(c, ct));
        Schedule(c, ClimateRisk, ct, async calls =>
        {
            var run = await toolUsingAgent.RunAsync(AgentPrompts.ClimateRisk(Facts(c)), georisquesMcp.Value.Endpoint, c.Siren, calls, ct);
            var result = (JsonObject)run.Output.DeepClone();
            result["naturalRisks"] = run.ToolRuns.LastOrDefault()?.Output.DeepClone(); // the Géorisques report
            return new StepOutcome(StepSummaries.ClimateRisk(run), result);
        }, skipWhen: NoLlmForCollectiveProcedure);
        Analyse(c, FinancialHealth, () => AgentPrompts.FinancialHealth(Facts(c)), StepSummaries.FinancialHealth, ct);
        Analyse(c, OpenItemsReview, () => AgentPrompts.OpenItemsReview(Facts(c)), StepSummaries.OpenItemsReview, ct);

        Recommendation? suggestion = null;
        Schedule(c, Synthesis, ct, async calls =>
        {
            if (UnderwritingRules.FindCollectiveProcedure(Result(LegalEvents)) is { } procedure)
                suggestion = UnderwritingRules.RefuseForCollectiveProcedure(procedure); // a rule, no LLM
            else
                suggestion = UnderwritingRules.FromSynthesis(await llm.AskAsync(AgentPrompts.Synthesis(Facts(c),
                    Analyses.ToDictionary(id => id, id => Result(id) as JsonObject)), c.Siren, calls, ct));
            return new StepOutcome(StepSummaries.Suggestion(suggestion), JsonSerializer.SerializeToNode(suggestion, CaseJson.Options));
        }, beforeStart: () =>
        {
            if (UnderwritingRules.FindCollectiveProcedure(Result(LegalEvents)) is not null)
                c.Update(x => x.Steps[Synthesis].Kind = StepKind.Rule);
        });
        await _steps[Synthesis];

        WaitForDecision(c, suggestion ?? UnderwritingRules.SynthesisUnavailable());
    }

    /// <summary>Starts the step once its dependsOn are done, unless skipWhen gives a reason not to run it.</summary>
    private void Schedule(UnderwritingCase c, string stepId, CancellationToken ct,
        Func<StepCalls, Task<StepOutcome>> work, Func<Task<string?>>? skipWhen = null, Action? beforeStart = null) =>
        _steps[stepId] = AfterDependencies(stepId, async () =>
        {
            if (skipWhen is not null && await skipWhen() is { } reason)
            {
                StepRunner.Skip(c, stepId, reason);
                return null;
            }
            beforeStart?.Invoke();
            return await steps.RunAsync(c, stepId, work, ct);
        });

    /// <summary>An LLM analysis. No LLM is ever called for a company under a collective procedure.</summary>
    private void Analyse(UnderwritingCase c, string stepId, Func<AgentPrompt> prompt, Func<JsonObject, string> summarize,
        CancellationToken ct) =>
        Schedule(c, stepId, ct, async calls =>
        {
            var answer = await llm.AskAsync(prompt(), c.Siren, calls, ct);
            return new StepOutcome(summarize(answer), answer);
        }, skipWhen: NoLlmForCollectiveProcedure);

    /// <summary>A rule gate, outside dependsOn: an LLM step always waits for BODACC before calling the model.</summary>
    private async Task<string?> NoLlmForCollectiveProcedure() =>
        UnderwritingRules.FindCollectiveProcedure(await _steps[LegalEvents]) is null ? null : NoLlmReason;

    private async Task<JsonNode?> AfterDependencies(string stepId, Func<Task<JsonNode?>> start)
    {
        await Task.WhenAll(NewSteps()[stepId].DependsOn.Select(id => _steps[id]));
        return await start();
    }

    private JsonNode? Result(string stepId) =>
        _steps.TryGetValue(stepId, out var step) && step.IsCompletedSuccessfully ? step.Result : null;

    private CaseFacts Facts(UnderwritingCase c) => new(c.Siren)
    {
        Customer = Result(CheckAccount), Identity = Result(CompanyIdentity), LegalEvents = Result(LegalEvents),
        Financials = Result(Financials), OpenItems = Result(OpenItems),
        DataQuality = Result(DataQuality), AdvisorReview = c.Update(x => x.DataReview),
    };

    private static async Task<JsonNode?> WaitForDataReviewAsync(UnderwritingCase c, CancellationToken ct)
    {
        c.Update(x =>
        {
            StepRunner.Wait(x.Steps[StepCatalog.DataReview], "En attente : le conseiller valide les données collectées.");
            x.PendingAction = PendingAction.DataReview;
        });
        var review = await c.DataReviewed.Task.WaitAsync(ct);
        return JsonSerializer.SerializeToNode(review, CaseJson.Options);
    }

    /// <summary>The suggestion and the risk reasons are shown to the advisor, who now has to decide.</summary>
    private static void WaitForDecision(UnderwritingCase c, Recommendation suggestion) => c.Update(x =>
    {
        x.Recommendation = suggestion;
        x.Escalation = RiskEscalation.Assess(x);
        StepRunner.Wait(x.Steps[StepCatalog.AdvisorDecision], StepSummaries.DecisionAwaited(x.Escalation));
        x.PendingAction = PendingAction.Decision;
    });
}
