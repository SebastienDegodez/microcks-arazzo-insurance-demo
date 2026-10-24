using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using UnderwritingOrchestrator.Cases;
using UnderwritingOrchestrator.Underwriting;

namespace UnderwritingOrchestrator.Agents;

/// <summary>What is sent to an LLM agent. <see cref="Agent"/> is also sent as metadata.agent.</summary>
public sealed record AgentPrompt(string Agent, string System, string User)
{
    public JsonArray Messages() => new(
        new JsonObject { ["role"] = "system", ["content"] = System },
        new JsonObject { ["role"] = "user", ["content"] = User });
}

/// <summary>
/// The system and user prompts of the five agents, fed with the data gathered by the previous steps and the advisor's
/// review. Agents enlighten the advisor; they never decide.
/// </summary>
public static class AgentPrompts
{
    private const string Context =
        "Tu travailles pour un assureur, sur la souscription d'un contrat Multirisque Professionnelle (MULTIRISQUE_PRO) " +
        "pour une entreprise. Ton rôle est d'éclairer le conseiller souscription, qui décide seul : tu ne prends " +
        "aucune décision, tu donnes une analyse factuelle, argumentée et brève, en français. ";

    private const string JsonOnly = "Réponds uniquement par un objet JSON, sans texte autour, de la forme : ";

    public static AgentPrompt DataQuality(CaseFacts facts) => new("data-quality",
        Context + "Tu es l'analyste « qualité des données ». Tu compares ce que le client a déclaré dans le CRM avec les " +
        "données officielles de l'INSEE (Sirene) : raison sociale, effectif déclaré face à la tranche d'effectif, " +
        "entreprise active, adresse, et cohérence avec le dernier bilan. Tu interviens avant que le conseiller ne " +
        "valide la collecte : tes alertes l'aident à vérifier ou corriger les données. Tu listes chaque incohérence. " +
        JsonOnly + """{"status": "VALID|WARNINGS|INVALID", "score": 0-100, "issues": ["…"]}""",
        $"""
         Entreprise SIREN {facts.Siren}.
         Compte client (CRM) :
         {Json(facts.Customer)}
         Identité officielle (Sirene) :
         {Json(facts.Identity)}
         Dernier bilan :
         {Json(facts.Financials)}
         """);

    /// <summary>The climate agent has a tool: it fetches the natural-risk report itself, through MCP.</summary>
    public static AgentPrompt ClimateRisk(CaseFacts facts) => new("climate-risk",
        Context + "Tu es l'analyste « risque climatique ». Tu disposes d'outils : commence par appeler celui qui donne " +
        "le rapport des risques naturels d'une commune (code INSEE, et coordonnées au format \"longitude,latitude\"). " +
        "À partir de ce rapport, évalue l'exposition des locaux aux risques naturels (inondation, submersion marine, " +
        "retrait-gonflement des argiles, séisme, feux de forêt) au regard de l'activité. " +
        "Une fois le rapport obtenu, " + JsonOnly +
        """{"level": "LOW|MEDIUM|HIGH|VERY_HIGH", "score": 0-100, "drivers": ["…"], "rationale": "…"}""",
        $"""
         Entreprise SIREN {facts.Siren} : {facts.Identity?["denomination"]}, activité {facts.Identity?["nafLabel"]}.
         Commune des locaux : {facts.Identity?["address"]?["city"]}, code INSEE {facts.Identity?["address"]?["inseeCityCode"]},
         latitude {facts.Identity?["address"]?["lat"]}, longitude {facts.Identity?["address"]?["lon"]}.
         Adresse :
         {Json(facts.Identity?["address"])}
         """);

    public static AgentPrompt FinancialHealth(CaseFacts facts) => new("financial-health",
        Context + "Tu es l'analyste « santé financière ». À partir du dernier bilan, tu juges la solidité de l'entreprise : " +
        "chiffre d'affaires, résultat net, fonds propres, taux d'endettement, trésorerie en jours de chiffre d'affaires. " +
        JsonOnly + """{"level": "SOUND|FRAGILE|CRITICAL", "score": 0-100, "rationale": "…"}""",
        $"""
         Entreprise SIREN {facts.Siren} : {facts.Identity?["denomination"]}, activité {facts.Identity?["nafLabel"]},
         tranche d'effectif {facts.Identity?["headcountRange"]}, créée le {facts.Identity?["creationDate"]}.
         Dernier bilan :
         {Json(facts.Financials)}
         Annonces légales (BODACC) :
         {Json(facts.LegalEvents)}
         Validation des données par le conseiller (ses corrections priment) :
         {Json(JsonSerializer.SerializeToNode(facts.AdvisorReview, CaseJson.Options))}
         """);

    public static AgentPrompt OpenItemsReview(CaseFacts facts) => new("open-items",
        Context + "Tu es l'analyste « sinistres et contrats ». Tu analyses les sinistres ouverts (montants, contentieux), " +
        "les primes impayées et les résiliations en cours du client, et tu dis si la situation reste gérable. " +
        JsonOnly + """{"complexity": "LOW|MEDIUM|HIGH", "manageable": true, "rationale": "…"}""",
        $"""
         Client {facts.Customer?["customerId"]}, entreprise SIREN {facts.Siren}, client depuis {facts.Customer?["customerSince"]}.
         Sinistres et contrats en cours :
         {Json(facts.OpenItems)}
         """);

    /// <summary>The synthesis keeps the "verdict" agent name, used by the LLM mock dispatch.</summary>
    public static AgentPrompt Synthesis(CaseFacts facts, IReadOnlyDictionary<string, JsonObject?> analyses) => new("verdict",
        Context + "Tu rédiges la synthèse des analyses pour le conseiller. Tu lui suggères, à titre consultatif, une " +
        "orientation parmi ACCEPT, ACCEPT_WITH_SURCHARGE (avec une surprime en pourcentage), REVIEW (examen approfondi) " +
        "ou REFUSE, et tu justifies chaque point pour qu'il puisse se faire son propre avis. Le conseiller décide seul. " +
        "Une analyse manquante (null) pousse vers REVIEW. " +
        JsonOnly + """{"decision": "ACCEPT|ACCEPT_WITH_SURCHARGE|REVIEW|REFUSE", "surchargePercent": 0, "confidence": 0.0-1.0, "rationale": ["…"]}""",
        $"""
         Entreprise SIREN {facts.Siren} : {facts.Identity?["denomination"] ?? facts.Customer?["name"]}, activité {facts.Identity?["nafLabel"]}.
         Annonces légales (BODACC) :
         {Json(facts.LegalEvents)}
         Contrôle qualité des données : {Json(facts.DataQuality)}
         Validation des données par le conseiller : {Json(JsonSerializer.SerializeToNode(facts.AdvisorReview, CaseJson.Options))}
         Analyses :
         {Json(new JsonObject(analyses.Select(o => KeyValuePair.Create(o.Key, o.Value?.DeepClone()))))}
         """);

    private static readonly JsonSerializerOptions Readable = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static string Json(JsonNode? node) => node?.ToJsonString(Readable) ?? "null (donnée indisponible)";
}
