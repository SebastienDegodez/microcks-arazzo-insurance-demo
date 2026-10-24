using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using UnderwritingOrchestrator.Agents;
using UnderwritingOrchestrator.Cases;

namespace UnderwritingOrchestrator.Dependencies;

/// <summary>Section "LlmGateway" of appsettings.json. Any OpenAI-compatible provider works.</summary>
public sealed class LlmGatewayOptions
{
    /// <summary>Base URL, without "/v1": the client calls {BaseUrl}/v1/chat/completions.</summary>
    public string BaseUrl { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public string Model { get; set; } = "gpt-4o-mini";
    /// <summary>The "metadata" field drives the Microcks mock dispatch; turn it off for a provider that rejects it.</summary>
    public bool SendMetadata { get; set; } = true;
    public int TimeoutSeconds { get; set; } = 120;

    /// <summary>
    /// Per-agent latency asked to the Microcks mock with x-microcks-delay headers, e.g. "financial-health":
    /// {"Delay": 50000, "Strategy": "random-20"} for a slow, 40 to 60 s answer.
    /// </summary>
    public Dictionary<string, MicrocksDelayOverride> DelayOverrides { get; set; } = new();
}

/// <summary>A tool the model asked to call: OpenAI tool_calls[i], with its arguments already parsed.</summary>
public sealed record ToolCall(string Id, string Name, JsonObject Arguments);

/// <summary>The model's answer: the assistant message as is (to send it back), its text, and the tools it asks for.</summary>
public sealed record ChatReply(JsonObject Message, string? Content, IReadOnlyList<ToolCall> ToolCalls);

/// <summary>Talks to an OpenAI-compatible Chat Completions API (POST {BaseUrl}/v1/chat/completions).</summary>
public sealed class LlmGatewayClient(HttpClient http, IOptions<LlmGatewayOptions> options)
{
    private readonly LlmGatewayOptions _options = options.Value;

    /// <summary>Asks an agent, without tools, and returns its JSON answer.</summary>
    public async Task<JsonObject> AskAsync(AgentPrompt prompt, string siren, StepCalls calls, CancellationToken ct)
    {
        var reply = await ChatAsync(prompt.Agent, siren, prompt.Messages(), tools: null, calls, ct);
        return ParseAgentOutput(reply.Content ?? throw new DependencyException("LLM : pas de choices[0].message.content"));
    }

    /// <summary>One chat completion. With <paramref name="tools"/>, the model may answer with tool_calls instead of text.</summary>
    public async Task<ChatReply> ChatAsync(
        string agent, string siren, JsonArray messages, JsonArray? tools, StepCalls calls, CancellationToken ct)
    {
        var url = Http.Combine(_options.BaseUrl, "v1/chat/completions");
        var request = new JsonObject
        {
            ["model"] = _options.Model,
            ["messages"] = messages.DeepClone(),
            ["response_format"] = new JsonObject { ["type"] = "json_object" },
        };
        if (tools is not null) request["tools"] = tools.DeepClone();
        if (_options.SendMetadata) request["metadata"] = new JsonObject { ["agent"] = agent, ["siren"] = siren };

        using var message = new HttpRequestMessage(HttpMethod.Post, url) { Content = JsonContent.Create(request) };
        if (_options.DelayOverrides.TryGetValue(agent, out var delayOverride))
            MicrocksDelayHandler.Apply(message, delayOverride);
        if (!string.IsNullOrWhiteSpace(_options.ApiKey))
            message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.ApiKey);

        using var response = await SendAsync(message, url, calls, ct);
        if (!response.IsSuccessStatusCode)
            throw new DependencyException($"LLM : réponse HTTP {(int)response.StatusCode}");

        var completion = await Http.ReadJsonAsync(response, ct);
        var assistant = completion?["choices"]?[0]?["message"] as JsonObject
            ?? throw new DependencyException("LLM : pas de choices[0].message");
        var toolCalls = (assistant["tool_calls"] as JsonArray ?? [])
            .Select(call => new ToolCall(
                call!["id"]!.ToString(),
                call["function"]!["name"]!.ToString(),
                JsonNode.Parse(call["function"]!["arguments"]?.ToString() is { Length: > 0 } args ? args : "{}") as JsonObject ?? []))
            .ToList();
        return new ChatReply((JsonObject)assistant.DeepClone(), assistant["content"]?.ToString(), toolCalls);
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage message, string url, StepCalls calls, CancellationToken ct)
    {
        try
        {
            var response = await http.SendAsync(message, ct);
            calls.Add("POST", url, (int)response.StatusCode, CallVia.Llm);
            return response;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            calls.Add("POST", url, Http.Unreachable, CallVia.Llm);
            throw new DependencyException($"LLM injoignable ({e.Message})");
        }
    }

    /// <summary>The agent output is a JSON string; some real models still wrap it in a ```json fence.</summary>
    public static JsonObject ParseAgentOutput(string content)
    {
        var json = content.Trim();
        if (json.StartsWith("```"))
            json = json[(json.IndexOf('\n') + 1)..json.LastIndexOf("```", StringComparison.Ordinal)];
        return JsonNode.Parse(json) as JsonObject
            ?? throw new DependencyException("LLM : la réponse de l'agent n'est pas un objet JSON");
    }
}
