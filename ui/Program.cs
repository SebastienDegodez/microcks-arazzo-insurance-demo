using System.Text.Json;
using CopiloteUi;

// Host of the "Copilote Souscription Pro" screen: serves wwwroot/ and a small BFF that forwards to the
// orchestrator (.NET, :5180) or to its stateful mock in Microcks (:8080). See ../SCENARIO.md.
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHttpClient("bff", c => c.Timeout = TimeSpan.FromSeconds(60))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        ConnectTimeout = TimeSpan.FromSeconds(2),
        AllowAutoRedirect = false,
        UseCookies = false,
    });
builder.Services.AddSingleton<FakeOrchestrator>();

var app = builder.Build();
var config = app.Configuration;

var backends = new Dictionary<string, string>(StringComparer.Ordinal)
{
    ["orchestrator"] = config["Backends:Orchestrator"] ?? "http://localhost:5180/",
    ["microcks"] = config["Backends:Microcks"] ?? "http://localhost:8080/rest/Underwriting+cases/1.0.0/",
};

app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl = "no-cache",
});

// Which backends answer, for the header badge and the "unreachable" message.
app.MapGet("/bff/health", async (IHttpClientFactory factory) =>
{
    var http = factory.CreateClient("bff");
    async Task<object> Orchestrator()
    {
        try
        {
            using var res = await http.GetAsync(backends["orchestrator"] + "underwriting-cases/health-probe");
            return new { reachable = true, status = (int)res.StatusCode };
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            return new { reachable = false, error = e.Message };
        }
    }
    async Task<object> Microcks()
    {
        try
        {
            var api = config["Backends:MicrocksApi"] ?? "http://localhost:8080/api/";
            using var res = await http.GetAsync(api + "services?size=200");
            var body = await res.Content.ReadAsStringAsync();
            var imported = false;
            if (res.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(body);
                imported = doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.EnumerateArray()
                    .Any(s => s.TryGetProperty("name", out var n) && n.GetString() == "Underwriting cases");
            }
            return new { reachable = true, mockImported = imported };
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
        {
            return new { reachable = false, mockImported = false, error = e.Message };
        }
    }
    var o = Orchestrator();
    var m = Microcks();
    return Results.Json(new { orchestrator = await o, microcks = await m });
});

// The BFF: method, body, Content-Type and status are passed through; X-Backend says who answered.
app.Map("/bff/{backend:regex(^(orchestrator|microcks|fake)$)}/{**path}", async (HttpContext ctx, string backend,
    IHttpClientFactory factory) =>
{
    var prefix = $"/bff/{backend}/";
    var rawPath = ctx.Request.Path.Value ?? "";
    var path = rawPath.Length > prefix.Length ? rawPath[prefix.Length..] : "";
    var baseUrl = backend == "fake"
        ? $"{ctx.Request.Scheme}://{ctx.Request.Host}/fake/"
        : backends[backend];
    var target = baseUrl + path + ctx.Request.QueryString.Value;

    using var req = new HttpRequestMessage(new HttpMethod(ctx.Request.Method), target);
    if (ctx.Request.ContentLength > 0 || ctx.Request.Headers.TransferEncoding.Count > 0)
    {
        req.Content = new StreamContent(ctx.Request.Body);
        if (ctx.Request.ContentType is { } ct)
            req.Content.Headers.TryAddWithoutValidation("Content-Type", ct);
    }
    req.Headers.TryAddWithoutValidation("Accept", ctx.Request.Headers.Accept.ToString() is { Length: > 0 } a
        ? a : "application/json");

    ctx.Response.Headers["X-Backend"] = backend;
    ctx.Response.Headers["Cache-Control"] = "no-store";
    try
    {
        using var res = await factory.CreateClient("bff")
            .SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ctx.RequestAborted);
        ctx.Response.StatusCode = (int)res.StatusCode;
        if (res.Content.Headers.ContentType is { } rct)
            ctx.Response.ContentType = rct.ToString();
        await res.Content.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
    }
    catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ctx.RequestAborted.IsCancellationRequested)
    {
        app.Logger.LogWarning("BFF {Backend} unreachable: {Target} ({Message})", backend, target, e.Message);
        ctx.Response.StatusCode = StatusCodes.Status502BadGateway;
        ctx.Response.Headers["X-Bff-Error"] = "unreachable";
        await ctx.Response.WriteAsJsonAsync(new
        {
            error = "BACKEND_UNREACHABLE",
            backend,
            target,
            detail = e.Message,
        });
    }
});

// Development-only stand-in that follows the contract, for working without the orchestrator (?backend=fake).
app.MapFakeOrchestrator();

app.Run();
