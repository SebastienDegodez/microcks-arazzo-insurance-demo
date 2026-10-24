namespace UnderwritingOrchestrator.Cases;

/// <summary>
/// The 12 steps of an underwriting case, in display order, with what each one waits for (see SCENARIO.md).
/// The workflow schedules every step from its <c>dependsOn</c>: the phase number only groups the display.
/// </summary>
public static class StepCatalog
{
    public const string CheckAccount = "checkAccount";
    public const string CompanyIdentity = "companyIdentity";
    public const string LegalEvents = "legalEvents";
    public const string Financials = "financials";
    public const string OpenItems = "openItems";
    public const string DataQuality = "dataQuality";
    public const string DataReview = "dataReview";
    public const string ClimateRisk = "climateRisk";
    public const string FinancialHealth = "financialHealth";
    public const string OpenItemsReview = "openItemsReview";
    public const string Synthesis = "synthesis";
    public const string AdvisorDecision = "advisorDecision";

    public static readonly IReadOnlyList<string> Order =
    [
        CheckAccount,
        CompanyIdentity, LegalEvents, Financials, OpenItems, DataQuality,
        DataReview,
        ClimateRisk, FinancialHealth, OpenItemsReview,
        Synthesis,
        AdvisorDecision,
    ];

    /// <summary>The LLM steps, by priority when they compete for an LLM slot.</summary>
    public static readonly IReadOnlyList<string> LlmPriority = [DataQuality, ClimateRisk, FinancialHealth, OpenItemsReview, Synthesis];

    public static readonly IReadOnlyList<string> Analyses = [ClimateRisk, FinancialHealth, OpenItemsReview];

    public static Dictionary<string, Step> NewSteps() => new()
    {
        [CheckAccount] = Step("Compte client", 1, StepMode.Chain, StepKind.Service),
        [CompanyIdentity] = Step("Identité de l'entreprise (Sirene)", 2, StepMode.Parallel, StepKind.Service, CheckAccount),
        [LegalEvents] = Step("Annonces légales (BODACC)", 2, StepMode.Parallel, StepKind.Service, CheckAccount),
        [Financials] = Step("Comptes annuels", 2, StepMode.Parallel, StepKind.Service, CheckAccount),
        [OpenItems] = Step("Sinistres et contrats", 2, StepMode.Parallel, StepKind.Service, CheckAccount),
        [DataQuality] = Step("Contrôle de la qualité des données", 2, StepMode.Chain, StepKind.Llm,
            CheckAccount, CompanyIdentity, Financials),
        [DataReview] = Step("Validation des données par le conseiller", 3, StepMode.Chain, StepKind.Human,
            CompanyIdentity, LegalEvents, Financials, OpenItems, DataQuality),
        [ClimateRisk] = Step("Analyse du risque climatique", 4, StepMode.Parallel, StepKind.Llm, CompanyIdentity, DataQuality),
        [FinancialHealth] = Step("Analyse de la santé financière", 4, StepMode.Parallel, StepKind.Llm,
            Financials, LegalEvents, DataReview),
        [OpenItemsReview] = Step("Analyse des sinistres et contrats", 4, StepMode.Parallel, StepKind.Llm, OpenItems, DataQuality),
        [Synthesis] = Step("Synthèse des analyses (consultative)", 5, StepMode.Chain, StepKind.Llm,
            ClimateRisk, FinancialHealth, OpenItemsReview, DataReview),
        [AdvisorDecision] = Step("Décision du conseiller", 6, StepMode.Chain, StepKind.Human, Synthesis),
    };

    private static Step Step(string label, int phase, StepMode mode, StepKind kind, params string[] dependsOn) =>
        new() { Label = label, Phase = phase, Mode = mode, Kind = kind, DependsOn = dependsOn };
}
