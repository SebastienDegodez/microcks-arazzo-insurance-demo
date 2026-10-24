using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using UnderwritingOrchestrator.WorkflowTests.Infrastructure;
using Xunit;

namespace UnderwritingOrchestrator.WorkflowTests;

/// <summary>Provider side: Microcks plays the advisor journey against the orchestrator's own API (S7/S14 runs).</summary>
public sealed class OrchestratorApiProviderTests(MicrocksFixture microcks)
{
    [Fact(Timeout = 420_000)]
    public async Task TheOrchestratorApiHonoursTheAdvisorJourney()
    {
        Assert.SkipWhen(microcks.RunsInContainer,
            "Needs the Arazzo minion, which has no image yet: run with MICROCKS_URL (demo stack).");
        var ct = TestContext.Current.CancellationToken;
        var arazzo = microcks.Arazzo();

        // Consumer side at the same time: one session, carried by every call of the run through a header secret
        var session = await arazzo.OpenSessionAsync(new ArazzoSessionRequest(
            "Commercial underwriting:1.0.0", "orchestratorCollectsCompanyData",
            new Dictionary<string, object?> { ["siren"] = "100000002" }), ct);
        var secretName = $"microcks-session-{session.Id}";
        await arazzo.CreateHeaderSecretAsync(secretName, MicrocksSession.Header, session.Id, ct);
        try
        {
            await using var orchestrator = new OrchestratorFactory(microcks);
            orchestrator.UseKestrel(0);   // .NET 10: a real port, reachable by the minion
            orchestrator.StartServer();
            var address = orchestrator.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses.First();   // http://127.0.0.1:<port>

            var run = await arazzo.RunAndWaitAsync("Commercial underwriting:1.0.0", "advisorValidatesThenDecides", new
            {
                example = "siren-100000002",                           // inputs and expected outputs of the overlay
                // The orchestrator, not its mock. Microcks asks a base URL for every source of the document, even
                // those this workflow never calls: the five REST sources get their mock (never called by this run).
                implementations = new
                {
                    underwritingApi = address,
                    customerAccounts = microcks.RestMock("Customer accounts"),
                    sirene = microcks.RestMock("Sirene"),
                    bodacc = microcks.RestMock("BODACC"),
                    companyFinancials = microcks.RestMock("Company financials"),
                    claimsAndContracts = microcks.RestMock("Claims and contracts"),
                },
                validateSchema = true,
                timeout = 30_000,
                secretName,                                            // x-microcks-session on every call
            }, TimeSpan.FromMinutes(6), ct);
            TestContext.Current.TestOutputHelper?.WriteLine(run.Explain());
            Assert.Equal("SUCCESS", run.Status);
            Assert.Equal("MATCHES", run.Example?.Verdict);

            var verdict = await arazzo.VerifyAsync(session.Id, ct);
            TestContext.Current.TestOutputHelper?.WriteLine(verdict.Explain());
            Assert.True(verdict.Succeeded, verdict.Explain());
        }
        finally
        {
            await arazzo.CloseAsync(session.Id);
        }
    }
}
