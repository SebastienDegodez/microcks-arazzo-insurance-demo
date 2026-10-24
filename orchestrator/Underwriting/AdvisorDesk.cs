using System.Text.Json;
using UnderwritingOrchestrator.Cases;
using static UnderwritingOrchestrator.Cases.StepCatalog;

namespace UnderwritingOrchestrator.Underwriting;

public sealed record DataReviewRequest(bool Confirmed, DataCorrections? Corrections, string? Comment);

/// <summary>finalDecision stays a string, so that an unknown value gets a readable 400 INVALID_DECISION.</summary>
public sealed record AdvisorDecisionRequest(
    string? FinalDecision, double? SurchargePercent, string? Comment, IReadOnlyList<string>? AcknowledgedReasons);

/// <summary>Why the advisor's request was refused; null when it was accepted.</summary>
public sealed record AdvisorRefusal(int HttpStatus, string Code, string Message);

/// <summary>The two human checkpoints: the advisor validates the data, then takes the decision.</summary>
public static class AdvisorDesk
{
    public static AdvisorRefusal? ReviewData(UnderwritingCase underwritingCase, DataReviewRequest request)
    {
        var review = new DataReview(request.Confirmed, request.Corrections ?? new DataCorrections(null), request.Comment ?? "",
            DateTimeOffset.UtcNow);
        var refusal = underwritingCase.Update(c =>
        {
            if (c.PendingAction != PendingAction.DataReview) return NotExpected("la validation des données");

            c.DataReview = review;
            StepRunner.Complete(c.Steps[StepCatalog.DataReview], StepSummaries.DataReview(review),
                JsonSerializer.SerializeToNode(review, CaseJson.Options));
            c.Status = CaseStatus.InProgress;
            c.PendingAction = null;
            return null;
        });
        if (refusal is null) underwritingCase.DataReviewed.TrySetResult(review); // the workflow resumes
        return refusal;
    }

    public static AdvisorRefusal? Decide(UnderwritingCase underwritingCase, AdvisorDecisionRequest request) =>
        underwritingCase.Update(c =>
        {
            if (c.PendingAction != PendingAction.Decision) return NotExpected("la décision");
            if (ParseDecision(request.FinalDecision) is not { } finalDecision)
                return new AdvisorRefusal(400, "INVALID_DECISION", "finalDecision n'est pas une décision connue.");

            var reasons = c.Escalation?.Reasons.Select(r => r.Code) ?? [];
            var reinforced = c.Escalation?.Level == EscalationLevel.Reinforced;
            var notAcknowledged = reasons.Except(request.AcknowledgedReasons ?? []).ToList();
            if (reinforced && notAcknowledged.Count > 0)
                return new AdvisorRefusal(400, "REASONS_NOT_ACKNOWLEDGED",
                    $"Décision renforcée : reconnaissez chaque raison de risque ({string.Join(", ", notAcknowledged)}).");

            var surcharge = request.SurchargePercent
                            ?? (finalDecision == c.Recommendation?.Decision ? c.Recommendation.SurchargePercent : 0);
            var follows = finalDecision == c.Recommendation?.Decision && surcharge == c.Recommendation.SurchargePercent;
            if ((reinforced || !follows) && string.IsNullOrWhiteSpace(request.Comment))
                return new AdvisorRefusal(400, "COMMENT_REQUIRED", reinforced
                    ? "Décision renforcée : le commentaire est obligatoire."
                    : "Le commentaire est obligatoire quand la décision s'écarte de la suggestion.");

            c.AdvisorDecision = new AdvisorDecision(finalDecision, surcharge, follows, request.Comment ?? "",
                request.AcknowledgedReasons ?? [], DateTimeOffset.UtcNow);
            StepRunner.Complete(c.Steps[StepCatalog.AdvisorDecision], StepSummaries.AdvisorDecision(c.AdvisorDecision),
                JsonSerializer.SerializeToNode(c.AdvisorDecision, CaseJson.Options));
            c.Status = CaseStatus.Decided;
            c.PendingAction = null;
            return null;
        });

    /// <summary>"ACCEPT_WITH_SURCHARGE" → Decision.AcceptWithSurcharge; anything else → null.</summary>
    private static Decision? ParseDecision(string? value) =>
        Enum.GetValues<Decision>().Cast<Decision?>()
            .FirstOrDefault(d => JsonNamingPolicy.SnakeCaseUpper.ConvertName(d!.Value.ToString()) == value);

    private static AdvisorRefusal NotExpected(string action) =>
        new(409, "NOT_EXPECTED", $"Le dossier n'attend pas {action} du conseiller.");
}
