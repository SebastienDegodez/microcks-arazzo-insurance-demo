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

    private static readonly string[] MainArtifacts =
    [
        "customer-accounts.openapi.yaml", "sirene.openapi.yaml", "bodacc.openapi.yaml", "georisques.openapi.yaml",
        "company-financials.openapi.yaml", "claims-and-contracts.openapi.yaml", "llm-gateway.openapi.yaml",
        "underwriting-cases.openapi.yaml", "underwriting.arazzo.yaml", "underwriting-guards.arazzo.yaml",
    ];
    private static readonly string[] ArazzoSourcesOverlays =
        ["underwriting.arazzo-sources.yaml", "underwriting-guards.arazzo-sources.yaml"];

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
            .WithSecondaryArtifacts(ArazzoSourcesOverlays.Select(Contract).ToArray()) // the overlays link the sources
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

    /// <summary>A client for the Microcks API (no authentication: uber image and demo stack run without Keycloak).</summary>
    public ArazzoVerificationClient Arazzo() =>
        new(new HttpClient { BaseAddress = BaseUrl, Timeout = TimeSpan.FromMinutes(2) });

    private static string Contract(string fileName) => Path.Combine(AppContext.BaseDirectory, "contracts", fileName);
}
