using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using UnderwritingOrchestrator.Cases;
using UnderwritingOrchestrator.Dependencies;

namespace UnderwritingOrchestrator.Underwriting;

/// <summary>Section "Orchestration" of appsettings.json.</summary>
public sealed class OrchestrationOptions
{
    /// <summary>A ready step waits a random 0.3 to 5 s before it starts (still PENDING): parallel calls leave out of order.</summary>
    public DelayRange StartJitterMilliseconds { get; set; } = new() { Min = 300, Max = 5000 };

    /// <summary>
    /// Extra artificial delays, 0 by default: the latency comes from the Microcks mocks themselves (delay and
    /// delayStrategy in each contract). Useful only in front of real APIs.
    /// </summary>
    public DelayRange ServiceDelayMilliseconds { get; set; } = new();
    public DelayRange LlmDelayMilliseconds { get; set; } = new();
}

/// <summary>Section "Llm" of appsettings.json.</summary>
public sealed class LlmOptions
{
    /// <summary>LLM calls running at the same time within a case; the others are QUEUED.</summary>
    public int MaxConcurrency { get; set; } = 2;

    /// <summary>How many rounds of tool calls an agent may ask for before it must answer.</summary>
    public int MaxToolRounds { get; set; } = 3;
}

public sealed class DelayRange
{
    public int Min { get; set; }
    public int Max { get; set; }

    public TimeSpan Draw() => TimeSpan.FromMilliseconds(Random.Shared.Next(Min, Math.Max(Min, Max) + 1));
}

/// <summary>What a step produced: one sentence for the UI and the useful data.</summary>
public sealed record StepOutcome(string Summary, JsonNode? Result);

/// <summary>
/// Runs one automated step of a case, once its dependencies are done: a random start offset (PENDING), an LLM slot
/// if needed (QUEUED), then RUNNING, the work itself, and DONE or FAILED, with timings and calls.
/// Human steps only wait (WAITING) and are ended by the advisor. One runner per case: it holds the case's LLM slots.
/// </summary>
public sealed class StepRunner(IOptions<OrchestrationOptions> options, IOptions<LlmOptions> llm, ILogger<StepRunner> log)
{
    private readonly LlmSlots _llmSlots = new(Math.Max(1, llm.Value.MaxConcurrency));

    public async Task<JsonNode?> RunAsync(
        UnderwritingCase underwritingCase, string stepId, Func<StepCalls, Task<StepOutcome>> work, CancellationToken ct)
    {
        await Task.Delay(options.Value.StartJitterMilliseconds.Draw(), ct);

        var kind = underwritingCase.Update(c => c.Steps[stepId].Kind);
        using var slot = kind == StepKind.Llm
            ? await _llmSlots.EnterAsync(StepCatalog.LlmPriority.ToList().IndexOf(stepId),
                () => underwritingCase.Update(c => c.Steps[stepId].Status = StepStatus.Queued), ct)
            : null;

        underwritingCase.Update(c => Start(c.Steps[stepId], StepStatus.Running));
        if (ArtificialDelay(kind) is { Ticks: > 0 } delay) await Task.Delay(delay, ct);

        var calls = new StepCalls(call => underwritingCase.Update(c => c.Steps[stepId].Calls.Add(call)));
        try
        {
            var outcome = await work(calls);
            underwritingCase.Update(c => End(c.Steps[stepId], StepStatus.Done, outcome.Summary, outcome.Result));
            return outcome.Result;
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            log.LogWarning("{CaseId} {StepId} failed: {Error}", underwritingCase.CaseId, stepId, e.Message);
            underwritingCase.Update(c => End(c.Steps[stepId], StepStatus.Failed, $"Échec : {e.Message}", null));
            return null;
        }
    }

    /// <summary>Marks a step that will not run (only if it has not started).</summary>
    public static void Skip(UnderwritingCase underwritingCase, string stepId, string reason) =>
        underwritingCase.Update(c =>
        {
            if (c.Steps[stepId].Status == StepStatus.Pending)
                End(c.Steps[stepId], StepStatus.Skipped, reason, null);
        });

    /// <summary>A human step starts waiting for the advisor.</summary>
    public static void Wait(Step step, string summary)
    {
        Start(step, StepStatus.Waiting);
        step.Summary = summary;
    }

    public static void Complete(Step step, string summary, JsonNode? result) => End(step, StepStatus.Done, summary, result);

    private static void Start(Step step, StepStatus status)
    {
        step.Status = status;
        step.StartedAt = DateTimeOffset.UtcNow;
    }

    private static void End(Step step, StepStatus status, string summary, JsonNode? result)
    {
        step.Status = status;
        step.EndedAt = DateTimeOffset.UtcNow;
        step.Summary = summary;
        step.Result = result;
    }

    private TimeSpan ArtificialDelay(StepKind kind) =>
        (kind == StepKind.Llm ? options.Value.LlmDelayMilliseconds : options.Value.ServiceDelayMilliseconds).Draw();
}
