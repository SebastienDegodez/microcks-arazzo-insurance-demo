using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using UnderwritingOrchestrator.Dependencies;

namespace UnderwritingOrchestrator.WorkflowTests.Infrastructure;

public static class Sabotage
{
    /// <summary>The classic bug: the claims are fetched with the SIREN instead of the customerId given by the CRM.</summary>
    public static void SendSirenInsteadOfCustomerId(IServiceCollection services) =>
        services.AddHttpClient(nameof(CompanyDataApis)).AddHttpMessageHandler(() => new SirenInsteadOfCustomerId());

    /// <summary>A "cache" answers BODACC without calling it: the orchestrator is happy, the journey is not.</summary>
    public static void SkipBodacc(IServiceCollection services) =>
        services.AddHttpClient(nameof(CompanyDataApis)).AddHttpMessageHandler(() => new BodaccCache());

    /// <summary>Sirene is called with the SIRET of the head office (SIREN + NIC 00012) instead of the SIREN.</summary>
    public static void SendSiretToSirene(IServiceCollection services) =>
        services.AddHttpClient(nameof(CompanyDataApis)).AddHttpMessageHandler(() => new SiretToSirene());

    /// <summary>For act 3d only: the CRM is slow today, so a call started before its answer wins the race.</summary>
    public static void SlowCrm(IServiceCollection services) =>
        services.AddHttpClient(nameof(CompanyDataApis)).AddHttpMessageHandler(() => new SlowCrmHandler());

    private sealed class SirenInsteadOfCustomerId : DelegatingHandler
    {
        private const string BySiren = "/customers/by-siren/";
        private string? _lastSiren;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var uri = request.RequestUri!;
            var path = uri.AbsolutePath;   // still escaped (Claims%20and%20contracts): rebuild as a string
            var bySiren = path.IndexOf(BySiren, StringComparison.Ordinal);
            if (bySiren >= 0)
                _lastSiren = path[(bySiren + BySiren.Length)..];
            else if (path.EndsWith("/open-items", StringComparison.Ordinal) && _lastSiren is not null)
            {
                var customers = path.LastIndexOf("/customers/", StringComparison.Ordinal);
                request.RequestUri = new Uri($"{uri.GetLeftPart(UriPartial.Authority)}{path[..customers]}/customers/{_lastSiren}/open-items");
            }
            return base.SendAsync(request, ct);
        }
    }

    private sealed class BodaccCache : DelegatingHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            request.RequestUri!.AbsolutePath.EndsWith("/annonces", StringComparison.Ordinal)
                ? Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    RequestMessage = request,
                    Content = JsonContent.Create(new { total = 0, records = Array.Empty<object>() }),
                })
                : base.SendAsync(request, ct);
    }

    private sealed class SiretToSirene : DelegatingHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var uri = request.RequestUri!;
            var path = uri.AbsolutePath;
            var siren = path.LastIndexOf("/siren/", StringComparison.Ordinal);
            if (siren >= 0 && path.Length - (siren + "/siren/".Length) == 9)
                request.RequestUri = new Uri($"{uri.GetLeftPart(UriPartial.Authority)}{path}00012{uri.Query}");
            return base.SendAsync(request, ct);
        }
    }

    private sealed class SlowCrmHandler : DelegatingHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsolutePath.Contains("/customers/by-siren/", StringComparison.Ordinal))
                await Task.Delay(TimeSpan.FromMilliseconds(800), ct);
            return await base.SendAsync(request, ct);
        }
    }
}
