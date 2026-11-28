using System.ClientModel;
using System.ClientModel.Primitives;
using System.Text.Json.Nodes;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using OpenAI;
using ChatClient = OpenAI.Chat.ChatClient;
using ChatCompletionOptions = OpenAI.Chat.ChatCompletionOptions;
using UnderwritingOrchestrator.Cases;
using UnderwritingOrchestrator.Dependencies;
using UnderwritingOrchestrator.Underwriting;

namespace UnderwritingOrchestrator.Agents;

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

/// <summary>The agent's structured answer, and the tools it ran to get there.</summary>
public sealed record AgentRun(JsonObject Output, IReadOnlyList<ToolRun> ToolRuns);

/// <summary>
/// The LLM agents of the case, built with Microsoft Agent Framework (<see cref="ChatClientAgent"/>) over the OpenAI
/// Chat Completions client. With tools, the agent framework runs the standard loop: the model answers with
/// tool_calls, the orchestrator runs them through MCP and sends the results back (role: tool), until the model
/// answers. The model never calls a tool itself.
/// </summary>
public sealed class UnderwritingAgents(
    IHttpMessageHandlerFactory handlers, McpTools mcp, IOptions<LlmGatewayOptions> gateway, IOptions<LlmOptions> llm)
{
    public const string HttpClientName = "llm-gateway";
    private readonly LlmGatewayOptions _gateway = gateway.Value;

    /// <summary>Asks an agent, without tools, and returns its JSON answer.</summary>
    public Task<JsonObject> AskAsync(AgentPrompt prompt, string siren, StepCalls calls, CancellationToken ct) =>
        RunAsync(prompt, siren, tools: [], calls, ct);

    /// <summary>Asks an agent that may use the tools of MCP servers (reShapr, Microcks' native MCP endpoint…).</summary>
    public async Task<AgentRun> AskWithToolsAsync(
        AgentPrompt prompt, IReadOnlyList<string> mcpEndpoints, string siren, StepCalls calls, CancellationToken ct)
    {
        await using var toolbox = await mcp.ConnectAsync(mcpEndpoints, calls, ct);
        var output = await RunAsync(prompt, siren, toolbox.Tools, calls, ct);
        return new AgentRun(output, toolbox.Runs);
    }

    private async Task<JsonObject> RunAsync(
        AgentPrompt prompt, string siren, IList<AITool> tools, StepCalls calls, CancellationToken ct)
    {
        using var http = StepHttpClient.Create(handlers, HttpClientName,
            new PrepareRequestHandler(request => Prepare(request, prompt.Agent)),
            new CallJournalHandler(calls, CallVia.Llm));
        var agent = new ChatClientAgent(OpenAiChatClient(http), new ChatClientAgentOptions
        {
            Name = prompt.Agent,
            ChatOptions = new ChatOptions
            {
                Instructions = prompt.System,
                Tools = tools,
                ResponseFormat = ChatResponseFormat.Json,
                RawRepresentationFactory = _ => Metadata(prompt.Agent, siren),
            },
        });

        try
        {
            var response = await agent.RunAsync(prompt.User, cancellationToken: ct);
            if (response.Messages.SelectMany(m => m.Contents).OfType<FunctionCallContent>()
                .Any(call => !response.Messages.SelectMany(m => m.Contents).OfType<FunctionResultContent>()
                    .Any(result => result.CallId == call.CallId)))
                throw new DependencyException($"l'agent demande encore un outil après {llm.Value.MaxToolRounds} tours");
            return ParseAgentOutput(response.Text);
        }
        catch (ClientResultException e)
        {
            throw new DependencyException(e.Status == Http.Unreachable
                ? $"LLM injoignable ({e.InnerException?.Message ?? e.Message})"
                : $"LLM : réponse HTTP {e.Status}");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new DependencyException($"LLM : pas de réponse après {_gateway.TimeoutSeconds} s");
        }
    }

    /// <summary>OpenAI Chat Completions, as an IChatClient that runs the tool calls (at most MaxToolRounds rounds).</summary>
    private IChatClient OpenAiChatClient(HttpClient http) =>
        new ChatClient(_gateway.Model, new ApiKeyCredential(string.IsNullOrWhiteSpace(_gateway.ApiKey) ? "none" : _gateway.ApiKey),
                new OpenAIClientOptions
                {
                    Endpoint = new Uri(Http.Combine(_gateway.BaseUrl, "v1")),
                    Transport = new HttpClientPipelineTransport(http),
                    RetryPolicy = new ClientRetryPolicy(maxRetries: 0), // every call is journaled: no hidden retry
                    NetworkTimeout = TimeSpan.FromSeconds(_gateway.TimeoutSeconds),
                })
            .AsIChatClient()
            .AsBuilder()
            .UseFunctionInvocation(configure: invoker =>
            {
                invoker.MaximumIterationsPerRequest = llm.Value.MaxToolRounds;
                invoker.MaximumConsecutiveErrorsPerRequest = 0; // a failing tool ends the step, as any dependency
            })
            .Build();

    /// <summary>metadata.agent and metadata.siren: the Microcks LLM mock answers according to them.</summary>
    private ChatCompletionOptions Metadata(string agent, string siren)
    {
        var options = new ChatCompletionOptions();
        if (_gateway.SendMetadata)
        {
            options.Metadata["agent"] = agent;
            options.Metadata["siren"] = siren;
        }
        return options;
    }

    private void Prepare(HttpRequestMessage request, string agent)
    {
        if (_gateway.DelayOverrides.TryGetValue(agent, out var delayOverride))
            MicrocksDelayHandler.Apply(request, delayOverride);
        if (string.IsNullOrWhiteSpace(_gateway.ApiKey))
            request.Headers.Authorization = null; // the OpenAI client always sends one; a keyless gateway gets none
    }

    /// <summary>The agent output is a JSON string; some real models still wrap it in a ```json fence.</summary>
    public static JsonObject ParseAgentOutput(string content)
    {
        var json = content.Trim();
        if (json.StartsWith("```"))
            json = json[(json.IndexOf('\n') + 1)..json.LastIndexOf("```", StringComparison.Ordinal)];
        try
        {
            return JsonNode.Parse(json) as JsonObject
                ?? throw new DependencyException("LLM : la réponse de l'agent n'est pas un objet JSON");
        }
        catch (System.Text.Json.JsonException)
        {
            throw new DependencyException("LLM : la réponse de l'agent n'est pas un objet JSON");
        }
    }
}
