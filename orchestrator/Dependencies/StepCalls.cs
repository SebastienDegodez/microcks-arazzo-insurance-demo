using System.Text.Json.Nodes;
using UnderwritingOrchestrator.Cases;

namespace UnderwritingOrchestrator.Dependencies;

/// <summary>Journal of the outgoing calls of one step: each call is pushed to the case as soon as it is answered.</summary>
public sealed class StepCalls(Action<OutgoingCall> record)
{
    public void Add(string method, string url, int status, CallVia via) => record(new OutgoingCall(method, url, status, via));
}

/// <summary>A dependency answered something the orchestrator cannot use. The step ends FAILED with this message.</summary>
public sealed class DependencyException(string message) : Exception(message);

public static class Http
{
    public static string Combine(string baseUrl, string relativePath) => $"{baseUrl.TrimEnd('/')}/{relativePath.TrimStart('/')}";

    /// <summary>Status 0 in a call means the dependency could not be reached at all.</summary>
    public const int Unreachable = 0;

    public static async Task<JsonNode?> ReadJsonAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var text = await response.Content.ReadAsStringAsync(ct);
        return string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
    }
}
