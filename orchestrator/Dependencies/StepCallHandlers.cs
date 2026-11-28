using System.Text.Json.Nodes;
using UnderwritingOrchestrator.Cases;

namespace UnderwritingOrchestrator.Dependencies;

/// <summary>
/// Journals the outgoing HTTP calls of one step (method, URL, status, via), as the UI and the Arazzo workflows read
/// them. It sits under the SDK clients (OpenAI, MCP), so the journal shows the calls they really make on the wire.
/// <paramref name="isJournaled"/> keeps only some of them, e.g. the MCP tool requests and not the session plumbing.
/// </summary>
public sealed class CallJournalHandler(
    StepCalls calls, CallVia via, Func<HttpRequestMessage, CancellationToken, Task<bool>>? isJournaled = null)
    : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var journaled = isJournaled is null || await isJournaled(request, ct);
        var url = request.RequestUri!.AbsoluteUri;
        try
        {
            var response = await base.SendAsync(request, ct);
            if (journaled) calls.Add(request.Method.Method, url, (int)response.StatusCode, via);
            return response;
        }
        catch (Exception e) when (journaled
            && (e is HttpRequestException || e is TaskCanceledException && !ct.IsCancellationRequested))
        {
            calls.Add(request.Method.Method, url, Http.Unreachable, via);
            throw;
        }
    }

    /// <summary>An MCP JSON-RPC request that the step journals: tools/list and tools/call, not the session plumbing.</summary>
    public static async Task<bool> IsMcpToolRequest(HttpRequestMessage request, CancellationToken ct)
    {
        if (request.Method != HttpMethod.Post || request.Content is null) return false;
        var body = await request.Content.ReadAsStringAsync(ct); // buffered: the request is still sent as is
        try
        {
            return (JsonNode.Parse(body) as JsonObject)?["method"]?.GetValue<string>() is "tools/list" or "tools/call";
        }
        catch (System.Text.Json.JsonException)
        {
            return false;
        }
    }
}

/// <summary>Changes a request before it leaves, e.g. to add the latency headers of one agent.</summary>
public sealed class PrepareRequestHandler(Action<HttpRequestMessage> prepare) : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        prepare(request);
        return base.SendAsync(request, ct);
    }
}

public static class StepHttpClient
{
    /// <summary>
    /// An HttpClient for one step: <paramref name="handlers"/> (outermost first), then the pooled handler chain of
    /// the named client (Microcks latency headers, and the session propagation of the tests).
    /// </summary>
    public static HttpClient Create(IHttpMessageHandlerFactory factory, string name, params DelegatingHandler[] handlers)
    {
        HttpMessageHandler inner = factory.CreateHandler(name); // owned by the factory: disposing it is a no-op
        foreach (var handler in handlers.Reverse())
        {
            handler.InnerHandler = inner;
            inner = handler;
        }
        return new HttpClient(inner) { Timeout = Timeout.InfiniteTimeSpan }; // the SDK clients own their timeouts
    }
}
