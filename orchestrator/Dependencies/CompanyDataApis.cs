using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using UnderwritingOrchestrator.Cases;

namespace UnderwritingOrchestrator.Dependencies;

/// <summary>Base URLs of the REST services (section "Services" of appsettings.json).</summary>
public sealed class ServiceUrls
{
    public string CustomerAccounts { get; set; } = "";
    public string Sirene { get; set; } = "";
    public string Bodacc { get; set; } = "";
    public string CompanyFinancials { get; set; } = "";
    public string ClaimsAndContracts { get; set; } = "";
}

/// <summary>The REST APIs that know the company: CRM, Sirene, BODACC, financials, claims.</summary>
public sealed class CompanyDataApis(HttpClient http, IOptions<ServiceUrls> options)
{
    private readonly ServiceUrls _urls = options.Value;

    /// <summary>The customer account, or null when the CRM answers 404 (unknown customer).</summary>
    public async Task<JsonNode?> FindCustomerAsync(string siren, StepCalls calls, CancellationToken ct)
    {
        var answer = await GetAsync(_urls.CustomerAccounts, $"customers/by-siren/{Uri.EscapeDataString(siren)}", calls, ct);
        return answer.Status == 404 ? null : Expect200(answer);
    }

    public async Task<JsonNode> GetCompanyIdentityAsync(string siren, StepCalls calls, CancellationToken ct) =>
        Expect200(await GetAsync(_urls.Sirene, $"siren/{Uri.EscapeDataString(siren)}", calls, ct));

    public async Task<JsonNode> GetLegalAnnouncementsAsync(string siren, StepCalls calls, CancellationToken ct) =>
        Expect200(await GetAsync(_urls.Bodacc, $"annonces?siren={Uri.EscapeDataString(siren)}", calls, ct));

    public async Task<JsonNode> GetFinancialsAsync(string siren, StepCalls calls, CancellationToken ct) =>
        Expect200(await GetAsync(_urls.CompanyFinancials, $"companies/{Uri.EscapeDataString(siren)}/financials", calls, ct));

    public async Task<JsonNode> GetOpenItemsAsync(string customerId, StepCalls calls, CancellationToken ct) =>
        Expect200(await GetAsync(_urls.ClaimsAndContracts, $"customers/{Uri.EscapeDataString(customerId)}/open-items", calls, ct));

    private async Task<(int Status, JsonNode? Body)> GetAsync(string baseUrl, string path, StepCalls calls, CancellationToken ct)
    {
        var url = Http.Combine(baseUrl, path);
        try
        {
            using var response = await http.GetAsync(url, ct);
            calls.Add("GET", url, (int)response.StatusCode, CallVia.Rest);
            return ((int)response.StatusCode, await Http.ReadJsonAsync(response, ct));
        }
        catch (HttpRequestException e)
        {
            calls.Add("GET", url, Http.Unreachable, CallVia.Rest);
            throw new DependencyException($"service injoignable ({e.Message})");
        }
    }

    private static JsonNode Expect200((int Status, JsonNode? Body) answer) => answer switch
    {
        (200, { } body) => body,
        (200, null) => throw new DependencyException("réponse vide"),
        _ => throw new DependencyException($"réponse HTTP {answer.Status}"),
    };
}
