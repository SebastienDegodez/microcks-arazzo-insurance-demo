using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace UnderwritingOrchestrator.WorkflowTests.Infrastructure;

/// <summary>
/// The real orchestrator, hosted in the test process, with every dependency pointed at a Microcks mock, the
/// latencies set to zero, and the Microcks session carried on every outgoing call.
/// <paramref name="sabotage"/> lets a test plant a bug, to show that the verification catches it.
/// </summary>
public sealed class OrchestratorFactory(MicrocksFixture microcks, Action<IServiceCollection>? sabotage = null)
    : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            // appsettings.json says http://localhost:5180: never bind the port of the running demo
            ["Urls"] = "http://127.0.0.1:0",

            // Section "Services": the five REST APIs
            ["Services:CustomerAccounts"] = microcks.RestMock("Customer accounts"),
            ["Services:Sirene"] = microcks.RestMock("Sirene"),
            ["Services:Bodacc"] = microcks.RestMock("BODACC"),
            ["Services:CompanyFinancials"] = microcks.RestMock("Company financials"),
            ["Services:ClaimsAndContracts"] = microcks.RestMock("Claims and contracts"),

            // The mocked LLM: the client calls {BaseUrl}/v1/chat/completions
            ["LlmGateway:BaseUrl"] = microcks.RestMock("LLM gateway"),
            // Microcks' native MCP server instead of reShapr (no Postgres/control plane/gateway in a test)
            ["Mcp:Georisques:Endpoint"] = microcks.McpEndpoint("Georisques"),

            // Latencies: x-microcks-delay: 0 on every call (MicrocksDelayHandler)...
            ["Demo:MicrocksDelayOverride:Delay"] = "0",
            ["Demo:MicrocksDelayOverride:Strategy"] = "fixed",
            // ...including the per-agent override of financial-health (50 s by default), which wins otherwise
            ["LlmGateway:DelayOverrides:financial-health:Delay"] = "0",
            ["LlmGateway:DelayOverrides:financial-health:Strategy"] = "fixed",
            // A short random start offset, kept on purpose: the order of the four collection calls changes from
            // one run to the next, and the verification stays green ("dependsOn relaxes", section 2.2).
            ["Orchestration:StartJitterMilliseconds:Min"] = "0",
            ["Orchestration:StartJitterMilliseconds:Max"] = "300",
        }));

        builder.ConfigureTestServices(services =>
        {
            services.AddMicrocksSessionPropagation();
            sabotage?.Invoke(services);
        });
    }

    /// <summary>A client of the orchestrator whose requests open the case in the given Microcks session.</summary>
    public HttpClient CreateClientInSession(string sessionId)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Add(MicrocksSession.Header, sessionId);
        return client;
    }
}
