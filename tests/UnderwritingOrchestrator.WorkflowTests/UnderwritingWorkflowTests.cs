using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using UnderwritingOrchestrator.WorkflowTests.Infrastructure;
using Xunit;

namespace UnderwritingOrchestrator.WorkflowTests;

/// <summary>
/// Consumer side: the real orchestrator calls the Microcks mocks in a session; Microcks says whether those calls
/// follow an Arazzo workflow. Each test has its own orchestrator (own in-memory CaseStore) and its own session:
/// they may run in parallel (section 2.8).
/// </summary>
public sealed class UnderwritingWorkflowTests(MicrocksFixture microcks)
{
    private const string Document = "Commercial underwriting:1.0.0";
    private const string Guards = "Commercial underwriting guards:1.0.0";
    private const string Collection = "orchestratorCollectsCompanyData";
    private const string HealthyCompany = "100000002";       // Atelier Mécanique Durand, C-1002, ACCEPT, STANDARD
    private const string OtherCompany = "100000003";          // the company of the BODACC collective procedure

    private static readonly string[] CollectionSteps =
        ["checkAccount", "companyIdentity", "legalEvents", "financials", "openItems"];

    private static Dictionary<string, object?> SirenInput(string siren) => new() { ["siren"] = siren };

    [Fact(Timeout = 180_000)]
    public async Task TheUnderwritingOrchestratorFollowsTheWorkflow()
    {
        var (decided, verdict) = await PlayInSessionAsync(
            new ArazzoSessionRequest(Document, Collection, SirenInput(HealthyCompany)),
            (desk, ct) => desk.RunWholeCaseAsync(HealthyCompany, ct));

        Assert.Equal("DECIDED", decided["status"]!.GetValue<string>());
        Assert.True(verdict.Succeeded, verdict.Explain());
        Assert.Equal("SESSION", verdict.Origin);
        Assert.Equal(CollectionSteps, verdict.Steps.OrderBy(s => s.Index).Select(s => s.StepId));
        Assert.Equal("C-1002", verdict.Outputs!["customerId"].GetString());
    }

    [Fact(Timeout = 180_000)]
    public async Task AnOrchestratorThatSendsTheSirenToClaimsIsCaught()
    {
        // The collection is over at DATA_REVIEW: no need to play the whole case
        var (_, verdict) = await PlayInSessionAsync(
            new ArazzoSessionRequest(Document, Collection, SirenInput(HealthyCompany)),
            (desk, ct) => desk.RunUntilDataReviewAsync(HealthyCompany, ct),
            Sabotage.SendSirenInsteadOfCustomerId);

        Assert.Equal("FAILURE", verdict.Status);
        var openItems = verdict.Step("openItems");
        Assert.Equal("FAILED", openItems.Status);
        Assert.Equal(200, openItems.StatusCode);   // S16: the mock answered, the orchestrator saw nothing wrong
        Assert.Equal(
            "`openItems` path `customerId` should come from `$steps.checkAccount.outputs.customerId` (C-1002), got 100000002",
            openItems.Message);
    }

    [Fact(Timeout = 180_000)]
    public async Task AnOrchestratorThatSkipsBodaccIsCaught()
    {
        var (_, verdict) = await PlayInSessionAsync(
            new ArazzoSessionRequest(Document, Collection, SirenInput(HealthyCompany)),
            (desk, ct) => desk.RunUntilDataReviewAsync(HealthyCompany, ct),
            Sabotage.SkipBodacc);

        Assert.Equal("FAILURE", verdict.Status);
        Assert.Equal("step `legalEvents` missing", verdict.Step("legalEvents").Message);
    }

    [Fact(Timeout = 180_000)]
    public async Task AnOrchestratorThatSendsTheSiretToSireneIsCaught()
    {
        var (_, verdict) = await PlayInSessionAsync(
            new ArazzoSessionRequest(Document, Collection, SirenInput(HealthyCompany)),
            (desk, ct) => desk.RunUntilDataReviewAsync(HealthyCompany, ct),
            Sabotage.SendSiretToSirene);

        Assert.Equal("FAILURE", verdict.Status);
        Assert.Equal(
            "`companyIdentity` path `siren` should come from `$inputs.siren` (100000002), got 10000000200012",
            verdict.Step("companyIdentity").Message);
    }

    // ----- Act 5: injected failures (S17) --------------------------------------------------------------------

    [Fact(Timeout = 180_000)]
    public async Task AnUnknownCustomerStopsTheCase()
    {
        var (_, verdict) = await PlayInSessionAsync(
            new ArazzoSessionRequest(Document, "customerUnknownStopsTheCase", SirenInput(HealthyCompany),
                new Dictionary<string, string> { ["checkAccount"] = "unknown-999999999" }),
            (desk, ct) => desk.RunUntilSettledAsync(HealthyCompany, ct));

        // Green means: checkAccount was called, and no call to Sirene, BODACC, financials or claims followed
        Assert.True(verdict.Succeeded, verdict.Explain());
        Assert.Equal(404, verdict.Step("checkAccount").StatusCode);   // successCriteria are not evaluated in a session
        Assert.DoesNotContain(verdict.Session!.Calls, call => call.Failure is not null);
    }

    [Fact(Timeout = 180_000)]
    public async Task ACollectiveProcedureStopsTheAnalyses()
    {
        var (_, verdict) = await PlayInSessionAsync(
            new ArazzoSessionRequest(Guards, "collectiveProcedureStopsTheAnalyses", SirenInput(HealthyCompany),
                new Dictionary<string, string> { ["legalEvents"] = "siren-100000003" }),
            (desk, ct) => desk.RunUntilSettledAsync(HealthyCompany, ct));

        // LLM gateway is linked in this document: one LLM call would be "unexpected call `…` after `…`"
        Assert.True(verdict.Succeeded, verdict.Explain());
        Assert.DoesNotContain(verdict.Session!.Calls, call => call.ApiName == "LLM gateway");
    }

    [Fact(Timeout = 240_000)]
    public async Task TwoCasesInParallelStayIsolated()
    {
        var healthy = PlayInSessionAsync(
            new ArazzoSessionRequest(Document, Collection, SirenInput(HealthyCompany)),
            (desk, ct) => desk.RunUntilDataReviewAsync(HealthyCompany, ct));
        var unknown = PlayInSessionAsync(
            new ArazzoSessionRequest(Document, "customerUnknownStopsTheCase", SirenInput(OtherCompany),
                new Dictionary<string, string> { ["checkAccount"] = "unknown-999999999" }),
            (desk, ct) => desk.RunUntilSettledAsync(OtherCompany, ct));

        var (_, a) = await healthy;
        var (_, b) = await unknown;

        Assert.True(a.Succeeded, a.Explain());
        Assert.True(b.Succeeded, b.Explain());
        // The failure injected in B never reached A, on the same CRM mock at the same time
        Assert.Equal(200, a.Step("checkAccount").StatusCode);
        Assert.Equal(404, b.Step("checkAccount").StatusCode);
        // Each session holds the calls of its own case only
        Assert.DoesNotContain(a.Session!.Calls, call => call.Path.Contains(OtherCompany));
        Assert.DoesNotContain(b.Session!.Calls, call => call.Path.Contains(HealthyCompany));
    }

    /// <summary>
    /// Opens the session, plays the case through a fresh orchestrator carrying it, verifies, prints the verdict,
    /// and closes the session in any case. Verify before closing: a closed session injects nothing any more.
    /// </summary>
    private async Task<(T Outcome, WorkflowResult Verdict)> PlayInSessionAsync<T>(
        ArazzoSessionRequest request,
        Func<UnderwritingDesk, CancellationToken, Task<T>> play,
        Action<IServiceCollection>? sabotage = null)
    {
        var ct = TestContext.Current.CancellationToken;
        var arazzo = microcks.Arazzo();
        var session = await arazzo.OpenSessionAsync(request, ct);
        try
        {
            await using var orchestrator = new OrchestratorFactory(microcks, sabotage);
            var outcome = await play(new UnderwritingDesk(orchestrator.CreateClientInSession(session.Id)), ct);
            var verdict = await arazzo.VerifyAsync(session.Id, ct);
            TestContext.Current.TestOutputHelper?.WriteLine(verdict.Explain());
            return (outcome, verdict);
        }
        finally
        {
            await arazzo.CloseAsync(session.Id);
        }
    }
}
