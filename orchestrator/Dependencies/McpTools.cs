using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using UnderwritingOrchestrator.Cases;

namespace UnderwritingOrchestrator.Dependencies;

/// <summary>
/// Section "Mcp" of appsettings.json: the MCP servers whose tools the agents get. Each one is reShapr or Microcks'
/// native MCP endpoint (/mcp/{api}/{version}): the orchestrator does not care, both speak MCP.
/// </summary>
public sealed class McpServersOptions
{
    /// <summary>Climate agent: Géorisques exposed by reShapr, Microcks simulating the API behind it.</summary>
    public string Georisques { get; set; } = "http://localhost:7778/mcp/reshapr/georisques-1-0-0-default";

    /// <summary>Climate agent: BODACC exposed by reShapr, Microcks simulating the API behind it.</summary>
    public string Bodacc { get; set; } = "http://localhost:7778/mcp/reshapr/bodacc-1-0-0-default";

    /// <summary>Financial-health agent: "pure Microcks", the native MCP endpoint of the Company financials mock.</summary>
    public string CompanyFinancials { get; set; } = "http://localhost:8080/mcp/Company%20financials/1.0.0";
}

/// <summary>A tool the agent ran through MCP, with what it got back.</summary>
public sealed record ToolRun(string Name, JsonObject Arguments, JsonNode Output);

/// <summary>
/// Opens the tools of MCP servers for one step, with the official MCP C# SDK (Streamable HTTP): it handles the
/// protocol (initialize, notifications/initialized, Mcp-Session-Id, MCP-Protocol-Version, closing the session).
/// Works with reShapr and with Microcks' native MCP endpoint.
/// </summary>
public sealed class McpTools(IHttpMessageHandlerFactory handlers, ILoggerFactory loggers)
{
    public const string HttpClientName = "mcp";

    /// <summary>One session per server, opened one after the other: the tools of all of them, together.</summary>
    public async Task<McpToolbox> ConnectAsync(IReadOnlyList<string> endpoints, StepCalls calls, CancellationToken ct)
    {
        var toolbox = new McpToolbox();
        try
        {
            foreach (var endpoint in endpoints)
            {
                var client = await ConnectAsync(endpoint, calls, ct);
                toolbox.Add(client, await Mcp(() => client.ListToolsAsync(cancellationToken: ct).AsTask()));
            }
            return toolbox;
        }
        catch
        {
            await toolbox.DisposeAsync();
            throw;
        }
    }

    private async Task<McpClient> ConnectAsync(string endpoint, StepCalls calls, CancellationToken ct)
    {
        var http = StepHttpClient.Create(handlers, HttpClientName,
            new CallJournalHandler(calls, CallVia.Mcp, CallJournalHandler.IsMcpToolRequest));
        http.Timeout = TimeSpan.FromSeconds(120);
        var transport = new HttpClientTransport(new HttpClientTransportOptions
        {
            Endpoint = new Uri(endpoint),
            Name = "georisques",
            TransportMode = HttpTransportMode.StreamableHttp,
            // Request/response only: no standalone GET stream for server-initiated messages, which this demo never uses.
            EnableStandaloneGetStream = false,
        }, http, loggers, ownsHttpClient: true);

        return await Mcp(() => McpClient.CreateAsync(transport, new McpClientOptions
        {
            ClientInfo = new Implementation { Name = "underwriting-orchestrator", Version = "1.0.0" },
        }, loggers, ct));
    }

    /// <summary>MCP failures end the step with a readable message.</summary>
    internal static async Task<T> Mcp<T>(Func<Task<T>> call)
    {
        try
        {
            return await call();
        }
        catch (Exception e) when (e is McpException or HttpRequestException)
        {
            throw new DependencyException($"MCP : {e.Message}");
        }
    }
}

/// <summary>The tools of the step's MCP sessions, as AI functions for the agent; each run is kept for the case.</summary>
public sealed class McpToolbox : IAsyncDisposable
{
    private readonly List<McpClient> _clients = [];
    private readonly List<ToolRun> _runs = [];

    public IList<AITool> Tools { get; } = [];
    public IReadOnlyList<ToolRun> Runs => _runs;

    internal void Add(McpClient client, IEnumerable<McpClientTool> tools)
    {
        _clients.Add(client);
        foreach (var tool in tools) Tools.Add(new JournaledTool(tool, _runs));
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var client in _clients) await client.DisposeAsync();
    }

    /// <summary>Calls the MCP tool and hands its JSON output to the model; a tool error ends the step.</summary>
    private sealed class JournaledTool(McpClientTool tool, List<ToolRun> runs) : DelegatingAIFunction(tool)
    {
        protected override async ValueTask<object?> InvokeCoreAsync(AIFunctionArguments arguments, CancellationToken ct)
        {
            var result = await McpTools.Mcp(() => tool.CallAsync(arguments, cancellationToken: ct).AsTask());
            var text = result.Content.OfType<TextContentBlock>().FirstOrDefault()?.Text;
            if (result.IsError == true)
                throw new DependencyException($"l'outil MCP {Name} a renvoyé une erreur : {text}");
            var output = (result.StructuredContent is { } structured ? JsonNode.Parse(structured.GetRawText()) : null)
                ?? (text is null ? null : JsonNode.Parse(text))
                ?? throw new DependencyException($"l'outil MCP {Name} n'a rien renvoyé");

            runs.Add(new ToolRun(Name,
                new JsonObject(arguments.Select(a => KeyValuePair.Create(a.Key, JsonSerializer.SerializeToNode(a.Value)))),
                output));
            return output;
        }
    }
}
