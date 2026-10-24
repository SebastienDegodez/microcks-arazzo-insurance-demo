using System.Collections.Concurrent;
using System.Text.Json.Nodes;

namespace CopiloteUi;

// A development stand-in that follows the "Underwriting cases" v2 contract of SCENARIO.md, with data from
// fake/cases.json: 13 steps, random delays (services 1.5–4.5 s, LLM 3–8 s, times Fake:TimeScale or ?timeScale=),
// a stop at each human checkpoint (dataReview, advisorDecision), escalation, and the 400/409 rules.
// Only reached through /bff/fake/…, never by default.
public sealed class FakeOrchestrator
{
    public static readonly (string Id, string Label, int Phase, string Mode, string Kind, string[] DependsOn)[] Steps =
    [
        ("checkAccount", "Compte client", 1, "CHAIN", "SERVICE", []),
        ("companyIdentity", "Identité de l'entreprise (Sirene)", 2, "PARALLEL", "SERVICE", ["checkAccount"]),
        ("legalEvents", "Annonces légales (BODACC)", 2, "PARALLEL", "SERVICE", ["checkAccount"]),
        ("financials", "Comptes annuels", 2, "PARALLEL", "SERVICE", ["checkAccount"]),
        ("openItems", "Sinistres et contrats", 2, "PARALLEL", "SERVICE", ["checkAccount"]),
        ("dataQuality", "Contrôle de la collecte", 2, "CHAIN", "LLM", ["checkAccount", "companyIdentity", "financials"]),
        ("dataReview", "Validation des données", 3, "CHAIN", "HUMAN", ["companyIdentity", "legalEvents", "financials", "openItems", "dataQuality"]),
        ("climateRisk", "Analyse risque climatique (outil MCP)", 4, "PARALLEL", "LLM", ["companyIdentity", "dataQuality"]),
        ("financialHealth", "Analyse santé financière", 4, "PARALLEL", "LLM", ["financials", "legalEvents", "dataReview"]),
        ("openItemsReview", "Analyse sinistres et contrats", 4, "PARALLEL", "LLM", ["openItems", "dataQuality"]),
        ("synthesis", "Synthèse des analyses", 5, "CHAIN", "LLM", ["climateRisk", "financialHealth", "openItemsReview", "dataReview"]),
        ("advisorDecision", "Décision du conseiller", 6, "CHAIN", "HUMAN", ["synthesis"]),
    ];
    private static readonly string[] LlmPriority = ["dataQuality", "climateRisk", "financialHealth", "openItemsReview", "synthesis"];
    // 12 steps (v3): no geoRisks, the climate agent fetches the natural risks through reShapr (MCP).
    private const int LlmSlots = 2;

    private readonly JsonObject _data;
    private readonly double _timeScale;
    private readonly ConcurrentDictionary<string, FakeCase> _cases = new();

    public FakeOrchestrator(IWebHostEnvironment env, IConfiguration config)
    {
        _data = JsonNode.Parse(File.ReadAllText(Path.Combine(env.ContentRootPath, "fake", "cases.json")))!.AsObject();
        _timeScale = config.GetValue("Fake:TimeScale", 1.0);
    }

    public FakeCase Create(string siren, string product, double? timeScale)
    {
        var scale = timeScale is > 0 and <= 10 ? timeScale.Value : _timeScale;
        var rnd = Random.Shared;
        var d = new Dictionary<string, TimeSpan>();
        foreach (var s in Steps)
        {
            var ms = s.Id is "financials" or "financialHealth" ? rnd.Next(12000, 40000)
                : s.Kind switch { "LLM" => rnd.Next(3000, 12000), "HUMAN" => 0, _ => rnd.Next(1000, 9000) };
            d[s.Id] = TimeSpan.FromMilliseconds(ms * scale);
            d["stagger:" + s.Id] = TimeSpan.FromMilliseconds((s.Kind is "SERVICE" or "MCP" && s.Phase > 1 ? rnd.Next(300, 5000) : 0) * scale);
        }
        d["rule"] = TimeSpan.FromMilliseconds(600 * scale);
        var id = $"case-{siren}";
        var c = new FakeCase(id, siren, product, DateTimeOffset.UtcNow, d);
        _cases[id] = c; // like the orchestrator: one live case per SIREN, a new POST replaces it
        return c;
    }

    public FakeCase? Find(string id) => _cases.GetValueOrDefault(id);

    private JsonObject Source(FakeCase c)
    {
        var known = _data.ContainsKey(c.Siren);
        var src = _data[known ? c.Siren : "999999999"]!.DeepClone().AsObject();
        return known ? src : JsonNode.Parse(src.ToJsonString().Replace("999999999", c.Siren))!.AsObject();
    }

    // When each step is ready, starts and ends (null end = waiting for the advisor), scheduled from dependsOn
    // with 2 LLM slots; skipped steps carry the moment they were skipped.
    private record struct Slot(DateTimeOffset Ready, DateTimeOffset Start, DateTimeOffset? End, bool Skipped);

    private Dictionary<string, Slot> Timeline(FakeCase c, string flow)
    {
        var t = new Dictionary<string, Slot>();
        var d = c.Durations;
        var byId = Steps.ToDictionary(s => s.Id);
        var t0 = c.CreatedAt;
        t["checkAccount"] = new(t0, t0, t0 + d["checkAccount"], false);
        var t1 = t["checkAccount"].End!.Value;
        if (flow == "unknown")
        {
            foreach (var s in Steps.Where(s => s.Phase is >= 2 and <= 5)) t[s.Id] = new(t1, t1, t1, true);
            t["advisorDecision"] = new(t1, t1, c.DecidedAt, false);
            return t;
        }
        var slots = Enumerable.Repeat(DateTimeOffset.MinValue, LlmSlots).ToArray();
        var deps = Steps.ToDictionary(s => s.Id, s => flow == "collective" && s.Id == "dataQuality" ? s.DependsOn.Append("legalEvents").ToArray() : s.DependsOn);
        bool progress;
        do
        {
            progress = false;
            // Every step whose dependencies are over, except LLM steps (they wait for a slot below).
            var ready = Steps.Where(s => !t.ContainsKey(s.Id) && deps[s.Id].All(x => t.TryGetValue(x, out var v) && v.End is not null)).ToList();
            foreach (var s in ready.Where(s => s.Kind != "LLM"))
            {
                var r = deps[s.Id].Max(x => t[x].End!.Value);
                if (s.Kind == "HUMAN")
                {
                    t[s.Id] = new(r, r, s.Id == "dataReview" ? c.DataReviewAt : c.DecidedAt, false);
                }
                else
                {
                    var start = r + d["stagger:" + s.Id];
                    t[s.Id] = new(r, start, start + d[s.Id], false);
                }
                progress = true;
            }
            var llm = ready.Where(s => s.Kind == "LLM").ToList();
            if (llm.Count == 0) continue;
            if (flow == "collective")
            {
                // No LLM after a collective procedure: the analyses are skipped and the synthesis is a rule.
                foreach (var s in llm)
                {
                    var r = deps[s.Id].Max(x => t[x].End!.Value);
                    if (s.Id == "synthesis") continue;
                    t[s.Id] = new(r, r, r, true);
                }
                if (llm.Any(s => s.Id == "synthesis"))
                {
                    var r = deps["synthesis"].Max(x => t[x].End!.Value);
                    t["synthesis"] = new(r, r, r + d["rule"], false);
                }
                progress = true;
                continue;
            }
            // The LLM step that can start first takes the earliest free slot (priority breaks ties).
            var next = llm.Select(s => (s, ready: deps[s.Id].Max(x => t[x].End!.Value)))
                .Select(x => (x.s, x.ready, start: x.ready > slots.Min() ? x.ready : slots.Min()))
                .OrderBy(x => x.start).ThenBy(x => Array.IndexOf(LlmPriority, x.s.Id)).First();
            var i = Array.IndexOf(slots, slots.Min());
            t[next.s.Id] = new(next.ready, next.start, next.start + d[next.s.Id], false);
            slots[i] = t[next.s.Id].End!.Value;
            progress = true;
        } while (progress);
        return t;
    }

    public JsonObject Render(FakeCase c)
    {
        var src = Source(c);
        var flow = src["flow"]!.GetValue<string>();
        var now = DateTimeOffset.UtcNow;
        var timeline = Timeline(c, flow);
        var steps = new JsonObject();
        string? pending = null;
        foreach (var s in Steps)
        {
            var d = src["steps"]![s.Id]?.AsObject() ?? new JsonObject();
            var step = new JsonObject
            {
                ["label"] = s.Label, ["phase"] = s.Phase, ["mode"] = s.Mode,
                ["kind"] = d["kind"]?.GetValue<string>() ?? s.Kind,
            };
            step["dependsOn"] = new JsonArray(s.DependsOn.Select(x => (JsonNode)JsonValue.Create(x)!).ToArray());
            if (!timeline.TryGetValue(s.Id, out var tl) || now < tl.Ready)
            {
                step["status"] = "PENDING";
            }
            else if (!tl.Skipped && now < tl.Start)
            {
                step["status"] = s.Kind == "LLM" ? "QUEUED" : "PENDING";
                if (s.Kind == "LLM") step["summary"] = "En file : attend un créneau LLM (2 au maximum).";
            }
            else if (tl.Skipped)
            {
                step["status"] = "SKIPPED";
                step["summary"] = d["summary"]?.DeepClone() ?? "Non exécutée.";
            }
            else if (tl.End is not { } end || now < end)
            {
                var human = s.Kind == "HUMAN";
                // Like the orchestrator, a call shows up in calls once it is over: reveal them as time goes by.
                if (!human && tl.End is { } e2 && d["calls"] is JsonArray all && all.Count > 1)
                {
                    var share = (now - tl.Start) / (e2 - tl.Start);
                    step["calls"] = new JsonArray(all.Take((int)Math.Floor(share * all.Count)).Select(x => x!.DeepClone()).ToArray());
                }
                step["status"] = human ? "WAITING" : "RUNNING";
                step["startedAt"] = tl.Start.ToString("O");
                if (human)
                {
                    pending = s.Id == "dataReview" ? "DATA_REVIEW" : "DECISION";
                    step["summary"] = s.Id == "dataReview" ? "En attente du conseiller : validation des données." : "En attente de la décision du conseiller.";
                }
            }
            else
            {
                step["status"] = "DONE";
                step["startedAt"] = tl.Start.ToString("O");
                step["endedAt"] = end.ToString("O");
                step["summary"] = s.Id switch
                {
                    "dataReview" => HumanSummary(c),
                    "advisorDecision" => $"Décision du conseiller : {c.Decision?["finalDecision"]}.",
                    _ => d["summary"]?.DeepClone(),
                };
                step["result"] = s.Id switch
                {
                    "dataReview" => c.DataReview?.DeepClone(),
                    "advisorDecision" => c.Decision?.DeepClone(),
                    _ => d["result"]?.DeepClone(),
                };
            }
            if (step["calls"] is null)
                step["calls"] = step["status"]!.GetValue<string>() == "DONE" ? d["calls"]?.DeepClone() ?? new JsonArray() : new JsonArray();
            steps[s.Id] = step;
        }

        var busy = steps.Select(kv => kv.Value!["status"]!.GetValue<string>()).Any(x => x is "RUNNING" or "QUEUED");
        var status = c.Decision is not null ? "DECIDED" : pending is not null && !busy ? "WAITING_ADVISOR" : "IN_PROGRESS";
        var result = new JsonObject
        {
            ["caseId"] = c.Id, ["siren"] = c.Siren, ["product"] = c.Product,
            ["createdAt"] = c.CreatedAt.ToString("O"),
            ["status"] = status,
            ["pendingAction"] = c.Decision is null ? pending : null,
            ["stepOrder"] = new JsonArray(Steps.Select(s => (JsonNode)JsonValue.Create(s.Id)!).ToArray()),
            ["steps"] = steps,
        };
        if (src["companyName"] is { } name) result["companyName"] = name.DeepClone();
        var suggestionReady = flow == "unknown"
            ? now >= timeline["checkAccount"].End
            : timeline.TryGetValue("synthesis", out var syn) && syn.End is { } se && now >= se;
        if (suggestionReady)
        {
            result["recommendation"] = src["recommendation"]!.DeepClone();
            result["escalation"] = Escalation(c, src);
        }
        if (c.DataReview is not null) result["dataReview"] = c.DataReview.DeepClone();
        if (c.Decision is not null) result["advisorDecision"] = c.Decision.DeepClone();
        return result;
    }

    private static string HumanSummary(FakeCase c)
    {
        var h = c.DataReview?["corrections"]?["declaredHeadcount"];
        return h is null ? "Données confirmées par le conseiller." : $"Données confirmées, effectif déclaré corrigé à {h}.";
    }

    public JsonObject Escalation(FakeCase c, JsonObject? src = null)
    {
        src ??= Source(c);
        var reasons = src["reasons"]!.AsArray().Select(r => r!.DeepClone()).ToList();
        if (c.DataReview?["corrections"]?["declaredHeadcount"] is not null && reasons.All(r => r!["code"]!.GetValue<string>() != "DATA_INCONSISTENT"))
            reasons.Add(new JsonObject { ["code"] = "DATA_INCONSISTENT", ["label"] = "Effectif déclaré corrigé par le conseiller", ["stepId"] = "dataQuality" });
        var codes = reasons.Select(r => r!["code"]!.GetValue<string>()).ToList();
        var reinforced = codes.Count >= 2 || codes.Contains("COLLECTIVE_PROCEDURE") || codes.Contains("UNKNOWN_CUSTOMER");
        return new JsonObject { ["level"] = reinforced ? "REINFORCED" : "STANDARD", ["reasons"] = new JsonArray(reasons.ToArray()) };
    }

    public JsonObject Recommendation(FakeCase c) => Source(c)["recommendation"]!.DeepClone().AsObject();
}

public sealed record FakeCase(string Id, string Siren, string Product, DateTimeOffset CreatedAt, Dictionary<string, TimeSpan> Durations)
{
    public DateTimeOffset? DataReviewAt { get; set; }
    public JsonObject? DataReview { get; set; }
    public DateTimeOffset? DecidedAt { get; set; }
    public JsonObject? Decision { get; set; }
}

public static class FakeOrchestratorEndpoints
{
    public static void MapFakeOrchestrator(this WebApplication app)
    {
        var g = app.MapGroup("/fake/underwriting-cases");
        g.MapPost("", async (HttpRequest req, FakeOrchestrator fake, double? timeScale) =>
        {
            var body = await JsonNode.ParseAsync(req.Body);
            var siren = body?["siren"]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(siren) || siren.Length != 9 || !siren.All(char.IsAsciiDigit))
                return Results.BadRequest(new { code = "INVALID_SIREN" });
            var c = fake.Create(siren, body?["product"]?.GetValue<string>() ?? "MULTIRISQUE_PRO", timeScale);
            return Results.Json(new { caseId = c.Id, status = "IN_PROGRESS" }, statusCode: 202);
        });
        g.MapGet("{caseId}", (string caseId, FakeOrchestrator fake) =>
            fake.Find(caseId) is { } c ? Results.Json(fake.Render(c)) : Results.NotFound(new { code = "CASE_NOT_FOUND" }));
        g.MapPost("{caseId}/data-review", async (string caseId, HttpRequest req, FakeOrchestrator fake) =>
        {
            if (fake.Find(caseId) is not { } c) return Results.NotFound(new { code = "CASE_NOT_FOUND" });
            if (fake.Render(c)["pendingAction"]?.GetValue<string>() != "DATA_REVIEW")
                return Results.Json(new { code = "NOT_EXPECTED" }, statusCode: 409);
            var body = (await JsonNode.ParseAsync(req.Body))?.AsObject() ?? new JsonObject();
            var now = DateTimeOffset.UtcNow;
            c.DataReview = new JsonObject
            {
                ["confirmed"] = body["confirmed"]?.DeepClone() ?? true,
                ["corrections"] = body["corrections"]?.DeepClone() ?? new JsonObject(),
                ["comment"] = body["comment"]?.DeepClone() ?? "",
                ["reviewedAt"] = now.ToString("O"),
            };
            c.DataReviewAt = now;
            return Results.Json(fake.Render(c));
        });
        g.MapPost("{caseId}/advisor-decision", async (string caseId, HttpRequest req, FakeOrchestrator fake) =>
        {
            if (fake.Find(caseId) is not { } c) return Results.NotFound(new { code = "CASE_NOT_FOUND" });
            var current = fake.Render(c);
            if (current["pendingAction"]?.GetValue<string>() != "DECISION")
                return Results.Json(new { code = "NOT_EXPECTED" }, statusCode: 409);
            var body = (await JsonNode.ParseAsync(req.Body))?.AsObject() ?? new JsonObject();
            var final = body["finalDecision"]?.GetValue<string>();
            if (string.IsNullOrEmpty(final)) return Results.BadRequest(new { code = "DECISION_REQUIRED" });
            var comment = body["comment"]?.GetValue<string>()?.Trim() ?? "";
            var esc = current["escalation"]!.AsObject();
            var reco = fake.Recommendation(c);
            var surcharge = body["surchargePercent"]?.GetValue<double>() ?? 0;
            var follows = final == reco["decision"]!.GetValue<string>()
                && (final != "ACCEPT_WITH_SURCHARGE" || Math.Abs(surcharge - reco["surchargePercent"]!.GetValue<double>()) < 0.01);
            if (esc["level"]!.GetValue<string>() == "REINFORCED")
            {
                var acked = body["acknowledgedReasons"]?.AsArray().Select(x => x!.GetValue<string>()).ToHashSet() ?? [];
                var all = esc["reasons"]!.AsArray().Select(r => r!["code"]!.GetValue<string>());
                if (!all.All(acked.Contains)) return Results.BadRequest(new { code = "REASONS_NOT_ACKNOWLEDGED" });
                if (comment.Length == 0) return Results.BadRequest(new { code = "COMMENT_REQUIRED" });
            }
            if (!follows && comment.Length == 0) return Results.BadRequest(new { code = "COMMENT_REQUIRED" });
            var now = DateTimeOffset.UtcNow;
            c.Decision = new JsonObject
            {
                ["finalDecision"] = final,
                ["surchargePercent"] = surcharge,
                ["followsRecommendation"] = follows,
                ["comment"] = comment,
                ["acknowledgedReasons"] = body["acknowledgedReasons"]?.DeepClone() ?? new JsonArray(),
                ["decidedAt"] = now.ToString("O"),
            };
            c.DecidedAt = now;
            return Results.Json(fake.Render(c));
        });
    }
}
