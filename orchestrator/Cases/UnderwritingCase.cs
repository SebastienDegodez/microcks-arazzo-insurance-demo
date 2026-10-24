using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace UnderwritingOrchestrator.Cases;

public enum CaseStatus { InProgress, WaitingAdvisor, Decided }
public enum PendingAction { DataReview, Decision }
public enum StepStatus { Pending, Queued, Running, Waiting, Done, Skipped, Failed }
public enum StepMode { Chain, Parallel }
public enum StepKind { Service, Mcp, Llm, Rule, Human }
public enum CallVia { Rest, Mcp, Llm }
public enum Decision { Accept, AcceptWithSurcharge, Review, Refuse, NotEligible }
public enum DecisionSource { Llm, Rule }
public enum EscalationLevel { Standard, Reinforced }

/// <summary>An outgoing call really made by a step, shown in the UI.</summary>
public sealed record OutgoingCall(string Method, string Url, int Status, CallVia Via);

/// <summary>The suggestion of the analyses. Advisory only: the advisor decides.</summary>
public sealed record Recommendation(
    Decision Decision, double SurchargePercent, double Confidence, IReadOnlyList<string> Rationale, DecisionSource Source);

public sealed record DataCorrections(int? DeclaredHeadcount);

/// <summary>The advisor checked, and possibly corrected, the collected data before any analysis.</summary>
public sealed record DataReview(bool Confirmed, DataCorrections Corrections, string Comment, DateTimeOffset ReviewedAt);

/// <summary>A risk reason the advisor must acknowledge in a reinforced decision.</summary>
public sealed record RiskReason(string Code, string Label, string StepId);

/// <summary>How much scrutiny the decision needs, known as soon as the case waits for the decision.</summary>
public sealed record Escalation(EscalationLevel Level, IReadOnlyList<RiskReason> Reasons);

/// <summary>The final decision, taken by the advisor.</summary>
public sealed record AdvisorDecision(
    Decision FinalDecision, double SurchargePercent, bool FollowsRecommendation, string Comment,
    IReadOnlyList<string> AcknowledgedReasons, DateTimeOffset DecidedAt);

public sealed class Step
{
    public required string Label { get; init; }
    public required int Phase { get; init; }
    public required StepMode Mode { get; init; }
    public required StepKind Kind { get; set; }
    public required IReadOnlyList<string> DependsOn { get; init; }
    public StepStatus Status { get; set; } = StepStatus.Pending;
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    public string? Summary { get; set; }
    public JsonNode? Result { get; set; }
    public List<OutgoingCall> Calls { get; } = [];

    [JsonIgnore]
    public bool IsFinished => Status is StepStatus.Done or StepStatus.Skipped or StepStatus.Failed;
}

/// <summary>
/// An underwriting case. The workflow updates it from a background task while the API reads it:
/// every change goes through <see cref="Update"/> and every read through <see cref="ToJson"/>, under the same lock.
/// </summary>
public sealed class UnderwritingCase
{
    private readonly Lock _gate = new();

    public required string CaseId { get; init; }
    public required string Siren { get; init; }
    public required string Product { get; init; }
    public string? CompanyName { get; set; }
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
    /// <summary>Derived after every change, see <see cref="RefreshStatus"/>; only DECIDED is set explicitly.</summary>
    public CaseStatus Status { get; set; } = CaseStatus.InProgress;

    /// <summary>The advisor's action, set as soon as it is possible, even while other steps still run.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public PendingAction? PendingAction { get; set; }

    public IReadOnlyList<string> StepOrder => StepCatalog.Order;
    public Dictionary<string, Step> Steps { get; } = StepCatalog.NewSteps();
    public Recommendation? Recommendation { get; set; }
    public DataReview? DataReview { get; set; }
    public Escalation? Escalation { get; set; }
    public AdvisorDecision? AdvisorDecision { get; set; }

    /// <summary>Completed when the advisor posts the data review: the workflow waits on it.</summary>
    [JsonIgnore]
    public TaskCompletionSource<DataReview> DataReviewed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Update(Action<UnderwritingCase> change)
    {
        lock (_gate)
        {
            change(this);
            RefreshStatus();
        }
    }

    public T Update<T>(Func<UnderwritingCase, T> change)
    {
        lock (_gate)
        {
            var result = change(this);
            RefreshStatus();
            return result;
        }
    }

    /// <summary>
    /// IN_PROGRESS while an automated step runs, waits for an LLM slot or can still start;
    /// WAITING_ADVISOR when every unfinished automated step is held up by a human step.
    /// </summary>
    private void RefreshStatus()
    {
        if (Status == CaseStatus.Decided) return;
        var automated = Steps.Values.Where(step => step.Kind != StepKind.Human && !step.IsFinished);
        Status = PendingAction is not null && automated.All(HeldUpByAdvisor)
            ? CaseStatus.WaitingAdvisor
            : CaseStatus.InProgress;
    }

    private bool HeldUpByAdvisor(Step step) => step.DependsOn.Select(id => Steps[id]).Any(dependency =>
        dependency.Kind == StepKind.Human ? dependency.Status != StepStatus.Done
                                          : !dependency.IsFinished && HeldUpByAdvisor(dependency));

    public string ToJson(JsonSerializerOptions options)
    {
        lock (_gate) return JsonSerializer.Serialize(this, options);
    }
}
