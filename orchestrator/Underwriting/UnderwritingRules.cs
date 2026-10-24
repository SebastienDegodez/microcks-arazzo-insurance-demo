using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using UnderwritingOrchestrator.Cases;

namespace UnderwritingOrchestrator.Underwriting;

/// <summary>The suggestions the orchestrator makes by itself, without asking an LLM. The advisor still decides.</summary>
public static class UnderwritingRules
{
    private static readonly string[] CollectiveProcedureMarkers = ["collective", "redressement", "liquidation", "sauvegarde"];

    public static Recommendation NotEligible(string siren) => new(
        Decision.NotEligible, 0, 1.0,
        [$"Aucun compte client pour le SIREN {siren} : le contrat est réservé aux clients."],
        DecisionSource.Rule);

    public static Recommendation CustomerAccountUnavailable() => new(
        Decision.Review, 0, 0.0,
        ["Le compte client n'a pas pu être vérifié : un souscripteur doit reprendre le dossier."],
        DecisionSource.Rule);

    /// <summary>The first BODACC announcement that reveals a collective procedure (redressement, liquidation, sauvegarde).</summary>
    public static JsonNode? FindCollectiveProcedure(JsonNode? legalEvents) =>
        legalEvents?["records"]?.AsArray().FirstOrDefault(record =>
        {
            var text = Normalize($"{record?["type"]} {record?["nature"]}");
            return CollectiveProcedureMarkers.Any(text.Contains);
        });

    public static Recommendation RefuseForCollectiveProcedure(JsonNode procedure) => new(
        Decision.Refuse, 0, 1.0,
        [
            $"Procédure collective au BODACC : {procedure["nature"] ?? procedure["type"]} ({procedure["date"]}, {procedure["court"]}).",
            "Règle de souscription : pas de nouveau contrat pendant une procédure collective ; aucune analyse IA lancée.",
        ],
        DecisionSource.Rule);

    public static Recommendation SynthesisUnavailable() => new(
        Decision.Review, 0, 0.0,
        ["La synthèse des analyses est indisponible : le dossier demande un examen complet par le conseiller."],
        DecisionSource.Rule);

    /// <summary>The synthesis output turned into a suggestion; anything unexpected falls back to REVIEW.</summary>
    public static Recommendation FromSynthesis(JsonObject verdict)
    {
        var decision = Enum.TryParse<Decision>(verdict["decision"]?.ToString().Replace("_", ""), ignoreCase: true, out var d)
                       && d != Decision.NotEligible ? d : Decision.Review;
        var rationale = verdict["rationale"] switch
        {
            JsonArray lines => lines.Select(l => l?.ToString() ?? "").Where(l => l.Length > 0).ToList(),
            { } line => [line.ToString()],
            null => new List<string>(),
        };
        return new Recommendation(decision, Number(verdict["surchargePercent"]) ?? 0, Number(verdict["confidence"]) ?? 0,
            rationale, DecisionSource.Llm);
    }

    public static double? Number(JsonNode? node) =>
        double.TryParse(node?.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? n : null;

    private static string Normalize(string text)
    {
        var decomposed = text.ToLowerInvariant().Replace('_', ' ').Normalize(NormalizationForm.FormD);
        return new string(decomposed.Where(c => CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark).ToArray());
    }
}
