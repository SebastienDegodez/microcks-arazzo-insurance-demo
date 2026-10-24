using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace UnderwritingOrchestrator.WorkflowTests.Infrastructure;

/// <summary>The Arazzo part of the Microcks API used by the tests (tag workflow of microcks-openapi-v1.16.yaml).</summary>
public sealed class ArazzoVerificationClient(HttpClient microcks)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        // inputs and failures are optional: leave them out rather than send null
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    // ----- Verification sessions (S15, S17) --------------------------------------------------------------------

    /// <summary>OpenArazzoSession; fails the test with Microcks' reason when the session is refused.</summary>
    public async Task<ArazzoSession> OpenSessionAsync(ArazzoSessionRequest request, CancellationToken ct)
    {
        var opening = await TryOpenSessionAsync(request, ct);
        return opening.Session
            ?? throw new InvalidOperationException($"Microcks refused the session: {opening.Refusal}");
    }

    /// <summary>
    /// POST /api/arazzo/sessions → 201 ArazzoSession (Location: /api/arazzo/sessions/{id}); 400 text/plain with the
    /// reason (unknown workflow, unknown/invalid/missing input, unknown failure step or example); 404 unknown document.
    /// </summary>
    public async Task<SessionOpening> TryOpenSessionAsync(ArazzoSessionRequest request, CancellationToken ct)
    {
        using var response = await microcks.PostAsJsonAsync("api/arazzo/sessions", request, Json, ct);
        if (response.StatusCode == HttpStatusCode.Created)
            return new((await response.Content.ReadFromJsonAsync<ArazzoSession>(Json, ct))!, null);
        var body = await response.Content.ReadAsStringAsync(ct);
        return response.StatusCode switch
        {
            HttpStatusCode.BadRequest => new(null, body),
            HttpStatusCode.NotFound => new(null, $"No Arazzo document {request.DocumentId}"),
            _ => throw new InvalidOperationException($"Microcks refused to open the session: HTTP {(int)response.StatusCode} {body}"),
        };
    }

    /// <summary>POST /api/arazzo/sessions/{id}/verification → 200 WorkflowResult (origin SESSION); 404 unknown session.</summary>
    public async Task<WorkflowResult> VerifyAsync(string sessionId, CancellationToken ct)
    {
        using var response = await microcks.PostAsync($"api/arazzo/sessions/{Uri.EscapeDataString(sessionId)}/verification", null, ct);
        await EnsureSuccessAsync(response, "verify the session", ct);
        return (await response.Content.ReadFromJsonAsync<WorkflowResult>(Json, ct))!;
    }

    /// <summary>
    /// DELETE /api/arazzo/sessions/{id} → 204, or 404 unknown session. Afterwards the session records and injects
    /// nothing, and stays verifiable for the retention delay. Best effort: never hides the test's own failure.
    /// </summary>
    public async Task CloseAsync(string sessionId)
    {
        try { using var _ = await microcks.DeleteAsync($"api/arazzo/sessions/{Uri.EscapeDataString(sessionId)}"); }
        catch (HttpRequestException) { /* the session expires on its own (max-open-duration) */ }
    }

    // ----- Runs (S7/S14) -----------------------------------------------------------------------------------------

    /// <summary>
    /// LaunchWorkflowRun then GetWorkflowRun until it is no longer IN_PROGRESS:
    /// POST /api/arazzo/documents/{documentId}/workflows/{workflowId}/runs, then GET /api/arazzo/runs/{runId}.
    /// documentId accepts "{title}:{version}".
    /// </summary>
    public async Task<WorkflowResult> RunAndWaitAsync(
        string documentId, string workflowId, object runRequest, TimeSpan timeout, CancellationToken ct)
    {
        var path = $"api/arazzo/documents/{Uri.EscapeDataString(documentId)}/workflows/{Uri.EscapeDataString(workflowId)}/runs";
        using var launched = await microcks.PostAsJsonAsync(path, runRequest, Json, ct);
        await EnsureSuccessAsync(launched, $"run {workflowId}", ct);
        var run = (await launched.Content.ReadFromJsonAsync<WorkflowResult>(Json, ct))!;

        var deadline = DateTime.UtcNow + timeout;
        while (run.Status == "IN_PROGRESS" && DateTime.UtcNow < deadline)
        {
            await Task.Delay(TimeSpan.FromSeconds(2), ct);
            run = (await microcks.GetFromJsonAsync<WorkflowResult>($"api/arazzo/runs/{run.Id}", Json, ct))!;
        }
        return run;
    }

    /// <summary>POST /api/secrets — a token secret whose token is sent in a header of our choice.</summary>
    public async Task CreateHeaderSecretAsync(string name, string header, string value, CancellationToken ct)
    {
        using var response = await microcks.PostAsJsonAsync("api/secrets",
            new { name, description = "Microcks session for a provider run", token = value, tokenHeader = header }, Json, ct);
        await EnsureSuccessAsync(response, "create the secret", ct);
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, string what, CancellationToken ct)
    {
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(
                $"Microcks refused to {what}: HTTP {(int)response.StatusCode} {await response.Content.ReadAsStringAsync(ct)}");
    }
}

/// <summary>ArazzoSessionRequest: the workflow, its inputs (checked when given) and the steps set to fail.</summary>
public sealed record ArazzoSessionRequest(
    string DocumentId,
    string WorkflowId,
    IReadOnlyDictionary<string, object?>? Inputs = null,
    IReadOnlyDictionary<string, string>? Failures = null);

/// <summary>ArazzoSession, as created (201).</summary>
public sealed record ArazzoSession(
    string Id, string DocumentId, string WorkflowId,
    string? DocumentTitle = null, string? DocumentVersion = null,
    long CallCount = 0, long DroppedCallCount = 0,
    IReadOnlyDictionary<string, JsonElement>? Inputs = null,
    IReadOnlyDictionary<string, string>? Failures = null);

/// <summary>The outcome of OpenArazzoSession: the session, or the reason Microcks gave for refusing it.</summary>
public sealed record SessionOpening(ArazzoSession? Session, string? Refusal);

/// <summary>WorkflowResult: a run, or the verification of a session when Origin is SESSION.</summary>
public sealed record WorkflowResult(
    string Id, string WorkflowId, string Status, IReadOnlyList<WorkflowStepResult> Steps,
    long? Number = null, string? DocumentId = null, string? Target = null,
    IReadOnlyDictionary<string, JsonElement>? Inputs = null,
    IReadOnlyDictionary<string, JsonElement>? Outputs = null,
    string? Message = null, string? Origin = null,
    WorkflowExampleCheck? Example = null, WorkflowSessionCheck? Session = null)
{
    public bool Succeeded => Status == "SUCCESS";

    public WorkflowStepResult Step(string stepId) => Steps.Single(s => s.StepId == stepId);

    /// <summary>One line per step, then the received calls: what the demo prints, and what a failing assertion shows.</summary>
    public string Explain()
    {
        var title = Origin == "SESSION" ? $"Verification #{Number}" : $"Run #{Number}";
        var text = new StringBuilder($"{title} · {WorkflowId}: {Status}{(Message is null ? "" : $" — {Message}")}");
        foreach (var step in Steps.OrderBy(s => s.Index))
        {
            text.Append($"\n  #{step.Index} {step.StepId,-16} {step.Status}");
            if (step.StatusCode is { } code) text.Append($" ({code})");
            if (step.Message is not null) text.Append($" — {step.Message}");
            foreach (var criterion in step.Criteria ?? [])
                if (!criterion.Held) text.Append($"\n      ✗ {criterion.Condition}");
        }
        if (Session is { } session)
        {
            text.Append($"\n  calls received in session {session.SessionId}:");
            foreach (var call in session.Calls.OrderBy(c => c.Index))
            {
                var outcome = call.Failure is not null ? $"unexpected — {call.Failure}" : call.StepId ?? "no step";
                text.Append($"\n    #{call.Index} {call.Method} {call.ApiName} {call.Path} → {outcome}");
            }
        }
        return text.ToString();
    }
}

public sealed record WorkflowStepResult(
    int Index, string StepId, string Status,
    WorkflowStepOperation? Operation = null, int? StatusCode = null, string? Message = null,
    IReadOnlyList<WorkflowCriterionResult>? Criteria = null,
    IReadOnlyDictionary<string, JsonElement>? Outputs = null,
    IReadOnlyList<WorkflowParameterValue>? Parameters = null,
    string? RequestUrl = null, string? TestCaseId = null);

public sealed record WorkflowStepOperation(string? SourceName, string? OperationId, string? Method, string? Path);

public sealed record WorkflowParameterValue(string Name, string In, JsonElement? Value = null, string? Expression = null);

public sealed record WorkflowCriterionResult(string Condition, bool Held);

public sealed record WorkflowExampleCheck(string Name, string? Verdict = null, IReadOnlyList<string>? UnmetExpectations = null);

/// <summary>WorkflowSessionCheck: the session verified and its calls, in their order of receipt.</summary>
public sealed record WorkflowSessionCheck(string SessionId, IReadOnlyList<WorkflowSessionCall> Calls);

/// <summary>WorkflowSessionCall: StepId absent when no step took it; Failure set when it is an unexpected call.</summary>
public sealed record WorkflowSessionCall(
    long Index, string Method, string Path,
    string? ApiName = null, string? ApiVersion = null, string? StepId = null, string? Failure = null);
