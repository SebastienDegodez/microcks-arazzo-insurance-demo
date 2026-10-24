using System.Globalization;
using System.Text.Json.Nodes;
using UnderwritingOrchestrator.Cases;
using UnderwritingOrchestrator.Agents;
using UnderwritingOrchestrator.Dependencies;
using static UnderwritingOrchestrator.Underwriting.UnderwritingRules;

namespace UnderwritingOrchestrator.Underwriting;

/// <summary>The one-sentence summary, in French, that the UI shows on each step card.</summary>
public static class StepSummaries
{
    private static readonly CultureInfo French = CultureInfo.GetCultureInfo("fr-FR");

    public static string CustomerFound(JsonNode customer) =>
        $"Client {customer["customerId"]} : {customer["name"]}, segment {customer["segment"]}, client depuis {customer["customerSince"]}.";

    public static string CustomerNotFound(string siren) => $"Aucun compte client pour le SIREN {siren} : dossier non éligible.";

    public static string CompanyIdentity(JsonNode identity) =>
        $"{identity["denomination"]} — {identity["nafLabel"]} ({identity["nafCode"]}), " +
        $"{identity["address"]?["city"]} ({identity["address"]?["postalCode"]}), " +
        (identity["active"]?.ToString() == "false" ? "entreprise cessée." : "entreprise active.");

    public static string LegalEvents(JsonNode legalEvents, JsonNode? collectiveProcedure) =>
        collectiveProcedure is not null
            ? $"Procédure collective au BODACC : {collectiveProcedure["nature"] ?? collectiveProcedure["type"]} " +
              $"({collectiveProcedure["date"]}, {collectiveProcedure["court"]})."
            : $"{legalEvents["total"] ?? 0} annonce(s) BODACC, aucune procédure collective.";

    public static string Financials(JsonNode financials) =>
        $"Exercice {financials["year"]} : CA {Euros(financials["revenue"])}, résultat {Euros(financials["netIncome"])}, " +
        $"endettement {Percent(financials["debtRatio"])}, trésorerie {financials["cashDays"]} jours.";

    public static string OpenItems(JsonNode openItems)
    {
        var claims = openItems["openClaims"]?.AsArray() ?? [];
        var litigations = claims.Count(c => c?["litigation"]?.ToString() == "true");
        return $"{claims.Count} sinistre(s) ouvert(s) dont {litigations} contentieux, " +
               $"primes impayées {Euros(openItems["unpaidPremiums"])}" +
               (openItems["pendingTermination"]?.ToString() == "true" ? ", résiliation en cours." : ".");
    }

    private static readonly Dictionary<string, string> RiskNames = new()
    {
        ["inondation"] = "inondation", ["submersionMarine"] = "submersion marine",
        ["retraitGonflementArgiles"] = "argiles", ["feuxForet"] = "feux de forêt",
    };

    private static readonly Dictionary<string, string> RiskLevels = new() { ["LOW"] = "faible", ["MEDIUM"] = "moyen", ["HIGH"] = "fort" };

    /// <summary>The natural risks of a Géorisques report, in a few words.</summary>
    public static string NaturalRisks(JsonNode? report)
    {
        var naturalRisks = report?["risquesNaturels"];
        var risks = RiskNames
            .Where(r => RiskLevels.ContainsKey(naturalRisks?[r.Key]?["level"]?.ToString() ?? "NONE"))
            .Select(r => $"{r.Value} {RiskLevels[naturalRisks![r.Key]!["level"]!.ToString()]}")
            .ToList();
        if (naturalRisks?["seisme"]?["zone"] is { } zone) risks.Add($"sismicité zone {zone}");
        return risks.Count == 0 ? "aucun risque naturel notable" : string.Join(", ", risks);
    }

    public static string DataQuality(JsonObject output) =>
        $"Données {output["status"]} (score {output["score"]})" +
        (output["issues"] is JsonArray { Count: > 0 } issues ? $" : {string.Join(" ; ", issues)}" : ".");

    public static string ClimateRisk(AgentRun run) =>
        $"Risque climatique {run.Output["level"]} (score {run.Output["score"]}) : {run.Output["rationale"]}" +
        string.Concat(run.ToolRuns.Select(tool => $" Outil MCP {tool.Name} : {NaturalRisks(tool.Output)}."));

    public static string FinancialHealth(JsonObject output) =>
        $"Santé financière {output["level"]} (score {output["score"]}) : {output["rationale"]}";

    public static string OpenItemsReview(JsonObject output) =>
        $"Complexité {output["complexity"]}, {(output["manageable"]?.ToString() == "true" ? "gérable" : "non gérable")} : {output["rationale"]}";

    public static string Suggestion(Recommendation r) =>
        $"Suggestion consultative : {DecisionLabel(r.Decision, r.SurchargePercent)}" +
        (r.Source == DecisionSource.Rule ? " (règle, sans LLM)." : $" (confiance {r.Confidence:P0}).");

    public static string DataReview(DataReview review) =>
        (review.Confirmed ? "Données confirmées par le conseiller" : "Données non confirmées par le conseiller") +
        (review.Corrections.DeclaredHeadcount is { } headcount ? $", effectif déclaré corrigé à {headcount}" : "") +
        (string.IsNullOrWhiteSpace(review.Comment) ? "." : $" : « {review.Comment} ».");

    public static string DecisionAwaited(Escalation escalation) => escalation.Level == EscalationLevel.Reinforced
        ? $"Décision humaine requise — risque trop important pour {escalation.Reasons.Count} raison(s)."
        : "En attente : le conseiller prend la décision.";

    public static string AdvisorDecision(AdvisorDecision d) =>
        $"Décision du conseiller : {DecisionLabel(d.FinalDecision, d.SurchargePercent)}, " +
        (d.FollowsRecommendation ? "conforme à la suggestion." : $"différente de la suggestion : « {d.Comment} ».");

    private static string DecisionLabel(Decision decision, double surchargePercent) => decision switch
    {
        Decision.Accept => "accepter",
        Decision.AcceptWithSurcharge => $"accepter avec une surprime de {surchargePercent.ToString(French)} %",
        Decision.Review => "examen approfondi",
        Decision.Refuse => "refuser",
        _ => "non éligible",
    };

    private static string Euros(JsonNode? amount)
    {
        if (Number(amount) is not { } n) return "?";
        return Math.Abs(n) switch
        {
            >= 1_000_000 => $"{(n / 1_000_000).ToString("0.#", French)} M€",
            >= 10_000 => $"{(n / 1_000).ToString("0", French)} k€",
            _ => $"{n.ToString("#,0", French)} €",
        };
    }

    /// <summary>A ratio such as 0.42, shown as 42 %.</summary>
    private static string Percent(JsonNode? ratio) =>
        Number(ratio) is { } n ? $"{(n * 100).ToString("0", French)} %" : "?";
}
