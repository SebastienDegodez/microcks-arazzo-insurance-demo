using UnderwritingOrchestrator.Agents;
using UnderwritingOrchestrator.Cases;
using UnderwritingOrchestrator.Dependencies;
using UnderwritingOrchestrator.Underwriting;

var builder = WebApplication.CreateBuilder(args);

builder.Services.ConfigureHttpJsonOptions(o => CaseJson.Configure(o.SerializerOptions));
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

builder.Services.Configure<ServiceUrls>(builder.Configuration.GetSection("Services"));
builder.Services.Configure<GeorisquesMcpOptions>(builder.Configuration.GetSection("Mcp:Georisques"));
builder.Services.Configure<LlmGatewayOptions>(builder.Configuration.GetSection("LlmGateway"));
builder.Services.Configure<OrchestrationOptions>(builder.Configuration.GetSection("Orchestration"));
builder.Services.Configure<LlmOptions>(builder.Configuration.GetSection("Llm"));
builder.Services.Configure<MicrocksDelayOverride>(builder.Configuration.GetSection("Demo:MicrocksDelayOverride"));
builder.Services.AddTransient<MicrocksDelayHandler>();

builder.Services.AddHttpClient<CompanyDataApis>(http => http.Timeout = TimeSpan.FromSeconds(120))
    .AddHttpMessageHandler<MicrocksDelayHandler>();
builder.Services.AddHttpClient<McpClient>(http => http.Timeout = TimeSpan.FromSeconds(120))
    .AddHttpMessageHandler<MicrocksDelayHandler>();
builder.Services.AddHttpClient<LlmGatewayClient>(http =>
        http.Timeout = TimeSpan.FromSeconds(builder.Configuration.GetValue("LlmGateway:TimeoutSeconds", 120)))
    .AddHttpMessageHandler<MicrocksDelayHandler>();
builder.Services.AddTransient<ToolUsingAgent>();
builder.Services.AddTransient<StepRunner>();
builder.Services.AddTransient<UnderwritingWorkflow>();
builder.Services.AddSingleton<CaseStore>();

var app = builder.Build();
app.UseCors();

var cases = app.MapGroup("/underwriting-cases");

cases.MapPost("", (OpenCaseRequest request, CaseStore store, UnderwritingWorkflow workflow, IHostApplicationLifetime host) =>
{
    var siren = request.Siren?.Trim() ?? "";
    if (siren.Length != 9 || !siren.All(char.IsAsciiDigit))
        return Results.BadRequest(new { Code = "INVALID_SIREN", Message = "Le SIREN doit comporter 9 chiffres." });

    var underwritingCase = store.Open(siren, request.Product ?? "MULTIRISQUE_PRO");
    workflow.Start(underwritingCase, host.ApplicationStopping);
    return Results.Accepted($"/underwriting-cases/{underwritingCase.CaseId}",
        new { underwritingCase.CaseId, Status = CaseStatus.InProgress });
});

cases.MapGet("{caseId}", (string caseId, CaseStore store) =>
    store.Find(caseId) is { } underwritingCase ? CaseResult(underwritingCase) : CaseNotFound(caseId));

cases.MapPost("{caseId}/data-review", (string caseId, DataReviewRequest request, CaseStore store) =>
    store.Find(caseId) is { } underwritingCase
        ? AdvisorAnswer(underwritingCase, AdvisorDesk.ReviewData(underwritingCase, request))
        : CaseNotFound(caseId));

cases.MapPost("{caseId}/advisor-decision", (string caseId, AdvisorDecisionRequest request, CaseStore store) =>
    store.Find(caseId) is { } underwritingCase
        ? AdvisorAnswer(underwritingCase, AdvisorDesk.Decide(underwritingCase, request))
        : CaseNotFound(caseId));

app.Run();

static IResult CaseResult(UnderwritingCase c) => Results.Content(c.ToJson(CaseJson.Options), "application/json");

static IResult AdvisorAnswer(UnderwritingCase c, AdvisorRefusal? refusal) => refusal is null
    ? CaseResult(c)
    : Results.Json(new { refusal.Code, refusal.Message }, statusCode: refusal.HttpStatus);

static IResult CaseNotFound(string caseId) =>
    Results.NotFound(new { Code = "CASE_NOT_FOUND", Message = $"Dossier {caseId} introuvable." });

record OpenCaseRequest(string? Siren, string? Product);
