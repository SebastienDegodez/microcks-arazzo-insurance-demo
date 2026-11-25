using Microcks.Testcontainers;
using Xunit;

namespace UnderwritingOrchestrator.WorkflowTests.Infrastructure;

/// <summary>
/// Microcks for the whole test assembly: a Testcontainers container built from feature/arazzo, or an already
/// running Microcks when MICROCKS_URL is set (the demo stack, contracts imported by scripts/import-contracts.sh).
/// </summary>
public sealed class MicrocksFixture : IAsyncLifetime
{
    /// <summary>Local uber image built from origin/feature/arazzo (see section 5).</summary>
    private const string DefaultImage = "microcks-uber:feature-arazzo";

    private static readonly string[] Apis =
    [
        "customer-accounts", "sirene", "bodacc", "georisques", "company-financials", "claims-and-contracts",
        "llm-gateway", "underwriting-cases",
    ];

    /// <summary>The pure API definitions, then the Arazzo documents.</summary>
    private static readonly string[] MainArtifacts =
    [
        .. Apis.Select(api => $"{api}.openapi.yaml"),
        "underwriting.arazzo.yaml", "underwriting-guards.arazzo.yaml", "underwriting-tools.arazzo.yaml",
    ];

    /// <summary>
    /// Microcks-only files: APIMetadata (dispatchers, latency) before APIExamples, so that the examples get their
    /// dispatch criteria; then the ArazzoSources overlays, which link the sources.
    /// </summary>
    private static readonly string[] SecondaryArtifacts =
    [
        .. Apis.Select(api => $"{api}.microcks-metadata.yaml"),
        .. Apis.Select(api => $"{api}.microcks-examples.yaml"),
        "underwriting.arazzo-sources.yaml", "underwriting-guards.arazzo-sources.yaml",
        "underwriting-tools.arazzo-sources.yaml",
    ];

    private MicrocksContainer? _container;

    /// <summary>Base URL of Microcks, ending with a slash.</summary>
    public Uri BaseUrl { get; private set; } = null!;

    /// <summary>True when Microcks runs in a container; false when the tests use MICROCKS_URL.</summary>
    public bool RunsInContainer => _container is not null;

    public async ValueTask InitializeAsync()
    {
        var running = Environment.GetEnvironmentVariable("MICROCKS_URL");
        if (!string.IsNullOrWhiteSpace(running))
        {
            BaseUrl = new Uri(running.TrimEnd('/') + "/");
            return;
        }

        _container = new MicrocksBuilder(Environment.GetEnvironmentVariable("MICROCKS_IMAGE") ?? DefaultImage)
            .WithMainArtifacts(MainArtifacts.Select(Contract).ToArray())             // imported in this order
            .WithSecondaryArtifacts(SecondaryArtifacts.Select(Contract).ToArray())   // imported in this order
            // HttpArazzoMinionClient reads @Value("${arazzo-minion.url}") without default, and the uber
            // config/application.properties does not set it. The environment property source resolves
            // arazzo-minion.url from ARAZZO_MINION_URL. No minion runs here: only runs would need it.
            .WithEnvironment("ARAZZO_MINION_URL", "http://arazzo-minion:8082")
            .Build();
        await _container.StartAsync();
        BaseUrl = new Uri(_container.GetHttpEndpoint().AbsoluteUri.TrimEnd('/') + "/");
    }

    public async ValueTask DisposeAsync()
    {
        if (_container is not null) await _container.DisposeAsync();
    }

    /// <summary>
    /// Base URL of the REST mock of an API, ending with a slash, as the orchestrator expects it.
    /// Same URL as <c>MicrocksContainer.GetRestMockEndpoint(name, "1.0.0")</c>, plus the trailing slash.
    /// </summary>
    public string RestMock(string apiName) =>
        new Uri(BaseUrl, $"rest/{Uri.EscapeDataString(apiName)}/1.0.0/").AbsoluteUri;

    /// <summary>Microcks' native MCP endpoint of an API (Streamable HTTP, JSON-RPC).</summary>
    public string McpEndpoint(string apiName) => new Uri(BaseUrl, $"mcp/{Uri.EscapeDataString(apiName)}/1.0.0").AbsoluteUri;

    /// <summary>
    /// reShapr gateway of the demo (scripts/start-reshapr.sh), e.g. http://localhost:7778, or null. Only with
    /// MICROCKS_URL: reShapr calls the Microcks mocks of the demo stack.
    /// </summary>
    public static string? ReshaprUrl => Environment.GetEnvironmentVariable("RESHAPR_MCP_URL") is { Length: > 0 } url
        ? url.TrimEnd('/') : null;

    /// <summary>A climate tool: through reShapr (scripts/start-reshapr.sh), or on Microcks' native MCP endpoint.</summary>
    public string ClimateToolEndpoint(string apiName, bool throughReshapr) => throughReshapr
        ? $"{ReshaprUrl ?? throw new InvalidOperationException("RESHAPR_MCP_URL is not set")}/mcp/reshapr/{apiName.ToLowerInvariant()}-1-0-0-default"
        : McpEndpoint(apiName);

    /// <summary>A client for the Microcks API (no authentication: uber image and demo stack run without Keycloak).</summary>
    public ArazzoVerificationClient Arazzo() =>
        new(new HttpClient { BaseAddress = BaseUrl, Timeout = TimeSpan.FromMinutes(2) });

    private static string Contract(string fileName) => Path.Combine(AppContext.BaseDirectory, "contracts", fileName);
}
