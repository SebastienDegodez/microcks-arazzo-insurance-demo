using System.Net.Http.Json;
using System.Text.Json.Nodes;
using UnderwritingOrchestrator.Cases;

namespace UnderwritingOrchestrator.Dependencies;

/// <summary>
/// A small generic MCP client over Streamable HTTP (JSON-RPC 2.0): initialize, tools/list, tools/call.
/// Works with Microcks' native MCP endpoint and with any MCP gateway (reShapr…): it keeps the Mcp-Session-Id
/// header if the server sends one, and reads either a JSON or a text/event-stream answer.
/// </summary>
/// <summary>Section "Mcp:Georisques" of appsettings.json: reShapr by default, or Microcks' native MCP endpoint.</summary>
public sealed class GeorisquesMcpOptions
{
    public string Endpoint { get; set; } = "http://localhost:7778/mcp/reshapr/georisques-1-0-0-default";
}

public sealed class McpClient(HttpClient http)
{
    public const string ProtocolVersion = "2025-06-18";

    public async Task<McpSession> ConnectAsync(string endpoint, StepCalls calls, CancellationToken ct)
    {
        var session = new McpSession(http, endpoint, calls);
        // Opening the session is transport plumbing: it is not listed in the step's calls, only tool calls are.
        await session.RequestAsync("initialize", traced: false, new JsonObject
        {
            ["protocolVersion"] = ProtocolVersion,
            ["capabilities"] = new JsonObject(),
            ["clientInfo"] = new JsonObject { ["name"] = "underwriting-orchestrator", ["version"] = "1.0.0" },
        }, ct);
        return session;
    }
}

public sealed record McpTool(string Name, string? Description, JsonObject InputSchema)
{
    public IEnumerable<string> ArgumentNames => InputSchema["properties"]?.AsObject().Select(p => p.Key) ?? [];
}

public sealed class McpSession(HttpClient http, string endpoint, StepCalls calls)
{
    private string? _sessionId;
    private int _nextId;

    public async Task<IReadOnlyList<McpTool>> ListToolsAsync(CancellationToken ct)
    {
        var result = await RequestAsync("tools/list", traced: true, new JsonObject(), ct);
        return result["tools"]?.AsArray()
            .Select(tool => new McpTool(
                tool!["name"]!.ToString(),
                tool["description"]?.ToString(),
                tool["inputSchema"] as JsonObject ?? new JsonObject()))
            .ToList() ?? [];
    }

    /// <summary>Calls a tool and returns its JSON output (structuredContent, or the JSON text content).</summary>
    public async Task<JsonNode> CallToolAsync(string toolName, JsonObject arguments, CancellationToken ct)
    {
        var result = await RequestAsync("tools/call", traced: true, new JsonObject { ["name"] = toolName, ["arguments"] = arguments }, ct);
        var text = result["content"]?.AsArray().FirstOrDefault(c => c?["type"]?.ToString() == "text")?["text"]?.ToString();
        if (result["isError"]?.GetValue<bool>() == true)
            throw new DependencyException($"l'outil MCP {toolName} a renvoyé une erreur : {text}");
        return result["structuredContent"]?.DeepClone()
            ?? (text is null ? null : JsonNode.Parse(text))
            ?? throw new DependencyException($"l'outil MCP {toolName} n'a rien renvoyé");
    }

    /// <summary>One JSON-RPC request; <paramref name="traced"/> lists it in the step's calls.</summary>
    public async Task<JsonNode> RequestAsync(string method, bool traced, JsonObject parameters, CancellationToken ct)
    {
        var id = Interlocked.Increment(ref _nextId);
        var message = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = parameters };
        using var response = await PostAsync(message, traced, ct);
        if (!response.IsSuccessStatusCode)
            throw new DependencyException($"MCP {method} : réponse HTTP {(int)response.StatusCode}");

        _sessionId ??= response.Headers.TryGetValues("Mcp-Session-Id", out var values) ? values.First() : null;
        var answer = await ReadAnswerAsync(response, id, ct)
            ?? throw new DependencyException($"MCP {method} : pas de réponse JSON-RPC");
        if (answer["error"] is { } error)
            throw new DependencyException($"MCP {method} : {error["message"]}");
        return answer["result"] ?? new JsonObject();
    }

    private async Task<HttpResponseMessage> PostAsync(JsonObject message, bool traced, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = JsonContent.Create(message) };
        request.Headers.Accept.ParseAdd("application/json");
        request.Headers.Accept.ParseAdd("text/event-stream");
        if (_sessionId is not null)
        {
            request.Headers.Add("Mcp-Session-Id", _sessionId);
            request.Headers.Add("MCP-Protocol-Version", McpClient.ProtocolVersion);
        }
        try
        {
            var response = await http.SendAsync(request, ct);
            if (traced) calls.Add("POST", endpoint, (int)response.StatusCode, CallVia.Mcp);
            return response;
        }
        catch (HttpRequestException e)
        {
            calls.Add("POST", endpoint, Http.Unreachable, CallVia.Mcp);
            throw new DependencyException($"serveur MCP injoignable ({e.Message})");
        }
    }

    /// <summary>The answer to request <paramref name="id"/>, sent either as plain JSON or as a server-sent event.</summary>
    private static async Task<JsonNode?> ReadAnswerAsync(HttpResponseMessage response, int id, CancellationToken ct)
    {
        var body = await response.Content.ReadAsStringAsync(ct);
        if (response.Content.Headers.ContentType?.MediaType != "text/event-stream")
            return JsonNode.Parse(body);

        var events = body.Replace("\r\n", "\n").Split("\n\n", StringSplitOptions.RemoveEmptyEntries);
        return events
            .Select(e => string.Join('\n', e.Split('\n').Where(l => l.StartsWith("data:")).Select(l => l[5..].TrimStart())))
            .Where(data => data.Length > 0)
            .Select(data => JsonNode.Parse(data))
            .FirstOrDefault(message => message?["id"]?.ToString() == id.ToString());
    }
}
