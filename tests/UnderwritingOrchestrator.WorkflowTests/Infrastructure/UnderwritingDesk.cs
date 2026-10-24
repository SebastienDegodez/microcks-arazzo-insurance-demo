using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace UnderwritingOrchestrator.WorkflowTests.Infrastructure;

/// <summary>Drives one underwriting case through the orchestrator's API, playing the advisor.</summary>
public sealed class UnderwritingDesk(HttpClient orchestrator)
{
    private static readonly TimeSpan Patience = TimeSpan.FromMinutes(2);

    /// <summary>
    /// A stopped case never has a status of its own: CRM 404 waits for the DECISION (NOT_ELIGIBLE, source RULE), a
    /// collective procedure waits for the DATA_REVIEW. pendingAction is what tells; DECIDED is the only end state.
    /// </summary>
    private static readonly string[] StoppedStatuses = ["DECIDED"];

    /// <summary>Opens a case, validates the data, follows the suggestion. Returns the DECIDED case.</summary>
    public async Task<JsonNode> RunWholeCaseAsync(string siren, CancellationToken ct)
    {
        var caseId = await OpenAsync(siren, ct);
        await WaitUntilAsync(caseId, c => PendingAction(c) == "DATA_REVIEW", ct);
        await PostAsync($"underwriting-cases/{caseId}/data-review",
            new { confirmed = true, corrections = new { }, comment = "Données vérifiées par le conseiller." }, ct);
        var waiting = await WaitUntilAsync(caseId, c => PendingAction(c) == "DECISION", ct);
        return await FollowSuggestionAsync(caseId, waiting, ct);
    }

    /// <summary>Opens a case and waits until the advisor must review the data: all collection calls are done.</summary>
    public async Task<JsonNode> RunUntilDataReviewAsync(string siren, CancellationToken ct) =>
        await WaitUntilAsync(await OpenAsync(siren, ct), c => PendingAction(c) == "DATA_REVIEW", ct);

    /// <summary>Opens a case and waits until the orchestrator stops or waits for the advisor, whichever comes first.</summary>
    public async Task<JsonNode> RunUntilSettledAsync(string siren, CancellationToken ct) =>
        await WaitUntilAsync(await OpenAsync(siren, ct),
            c => PendingAction(c) is not null || StoppedStatuses.Contains(c["status"]?.GetValue<string>()), ct);

    private static string? PendingAction(JsonNode current) => current["pendingAction"]?.GetValue<string>();

    private async Task<string> OpenAsync(string siren, CancellationToken ct)
    {
        using var response = await orchestrator.PostAsJsonAsync("underwriting-cases", new { siren, product = "MULTIRISQUE_PRO" }, ct);
        if (response.StatusCode != HttpStatusCode.Accepted)
            throw new InvalidOperationException($"POST /underwriting-cases: HTTP {(int)response.StatusCode}");
        var body = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct))!;
        return body["caseId"]!.GetValue<string>();   // case-<siren>
    }

    private async Task<JsonNode> WaitUntilAsync(string caseId, Func<JsonNode, bool> reached, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow + Patience;
        while (DateTime.UtcNow < deadline)
        {
            var current = JsonNode.Parse(await orchestrator.GetStringAsync($"underwriting-cases/{caseId}", ct))!;
            if (reached(current)) return current;
            await Task.Delay(TimeSpan.FromMilliseconds(500), ct);
        }
        throw new TimeoutException($"{caseId} never reached the expected state");
    }

    private async Task<JsonNode> FollowSuggestionAsync(string caseId, JsonNode waiting, CancellationToken ct)
    {
        var suggestion = waiting["recommendation"]!;
        var reasons = waiting["escalation"]?["reasons"]?.AsArray()
            .Select(r => r!["code"]!.GetValue<string>()).ToArray() ?? [];
        return await PostAsync($"underwriting-cases/{caseId}/advisor-decision", new
        {
            finalDecision = suggestion["decision"]!.GetValue<string>(),
            surchargePercent = suggestion["surchargePercent"]?.GetValue<int>() ?? 0,
            comment = "Je suis la suggestion des analyses.",
            acknowledgedReasons = reasons,   // required in REINFORCED; [] for 100000002 (STANDARD)
        }, ct);
    }

    private async Task<JsonNode> PostAsync(string path, object body, CancellationToken ct)
    {
        using var response = await orchestrator.PostAsJsonAsync(path, body, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"POST /{path}: HTTP {(int)response.StatusCode} {text}");
        return JsonNode.Parse(text)!;
    }
}
