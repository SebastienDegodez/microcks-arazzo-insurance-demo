using System.Text.Json.Nodes;
using UnderwritingOrchestrator.Cases;
using static UnderwritingOrchestrator.Cases.StepCatalog;

namespace UnderwritingOrchestrator.Underwriting;

/// <summary>
/// Deterministic rule, not an LLM: lists the risk reasons found in the case, and asks for a reinforced decision
/// from two reasons on, or as soon as the customer is unknown or under a collective procedure.
/// </summary>
public static class RiskEscalation
{
    private static readonly string[] Blocking = ["UNKNOWN_CUSTOMER", "COLLECTIVE_PROCEDURE"];

    public static Escalation Assess(UnderwritingCase c)
    {
        var reasons = new[]
        {
            UnknownCustomer(c), CollectiveProcedure(c), ClimateHigh(c), FinancialFragile(c), OpenLitigation(c),
            DataInconsistent(c),
        }.OfType<RiskReason>().ToList();

        var reinforced = reasons.Count >= 2 || reasons.Any(r => Blocking.Contains(r.Code));
        return new Escalation(reinforced ? EscalationLevel.Reinforced : EscalationLevel.Standard, reasons);
    }

    private static RiskReason? UnknownCustomer(UnderwritingCase c) =>
        Result(c, CheckAccount)?["code"]?.ToString() == "CUSTOMER_NOT_FOUND"
            ? new("UNKNOWN_CUSTOMER", "Aucun compte client pour ce SIREN : le contrat est réservé aux clients.", CheckAccount)
            : null;

    private static RiskReason? CollectiveProcedure(UnderwritingCase c) =>
        UnderwritingRules.FindCollectiveProcedure(Result(c, LegalEvents)) is { } procedure
            ? new("COLLECTIVE_PROCEDURE",
                $"Procédure collective au BODACC : {procedure["nature"] ?? procedure["type"]} ({procedure["date"]}).", LegalEvents)
            : null;

    private static RiskReason? ClimateHigh(UnderwritingCase c) =>
        Result(c, ClimateRisk) is { } climate && climate["level"]?.ToString() is "HIGH" or "VERY_HIGH"
            ? new("CLIMATE_HIGH",
                $"Exposition climatique {climate["level"]} : {climate["drivers"]?[0] ?? climate["rationale"]}.", ClimateRisk)
            : null;

    private static RiskReason? FinancialFragile(UnderwritingCase c) =>
        Result(c, FinancialHealth) is { } health && health["level"]?.ToString() is "FRAGILE" or "CRITICAL"
            ? new("FINANCIAL_FRAGILE", $"Santé financière {health["level"]} : {health["rationale"]}", FinancialHealth)
            : null;

    private static RiskReason? OpenLitigation(UnderwritingCase c)
    {
        var litigations = (Result(c, OpenItems)?["openClaims"]?.AsArray() ?? [])
            .Where(claim => claim?["litigation"]?.ToString() == "true")
            .Select(claim => $"{claim!["claimId"]}, {claim["amount"]} €")
            .ToList();
        return litigations.Count > 0
            ? new("OPEN_LITIGATION", $"Sinistre ouvert en contentieux ({string.Join(" ; ", litigations)}).", OpenItems)
            : null;
    }

    private static RiskReason? DataInconsistent(UnderwritingCase c)
    {
        var declared = Result(c, CheckAccount)?["declaredHeadcount"]?.ToString();
        var corrected = c.DataReview?.Corrections.DeclaredHeadcount;
        if (corrected is not null && corrected.ToString() != declared)
            return new("DATA_INCONSISTENT",
                $"Effectif déclaré corrigé par le conseiller ({declared} → {corrected}).", DataQuality);

        return Result(c, DataQuality) is { } quality && quality["status"]?.ToString() is "WARNINGS" or "INVALID"
            ? new("DATA_INCONSISTENT",
                $"Données {quality["status"]} : {quality["issues"]?[0] ?? "incohérences relevées"}", DataQuality)
            : null;
    }

    private static JsonNode? Result(UnderwritingCase c, string stepId) => c.Steps[stepId].Result;
}
