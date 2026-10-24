#!/usr/bin/env python3
"""Generates every contract of contracts/ from the single table of the five demo companies.

Usage: python3 scripts/generate-contracts.py   (no dependency, writes contracts/*.yaml)

The data below is the one source of truth: the mocks of the seven APIs, the LLM answers, the snapshots of the
orchestrator mock, the Arazzo workflows and their examples are all derived from it, so they stay consistent.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = ROOT / "contracts"

MICROCKS = "http://localhost:8080"
# Georisques is exposed in MCP by reShapr (Microcks simulates the REST API behind it), as the orchestrator calls it.
MCP_URL = "http://localhost:7778/mcp/reshapr/georisques-1-0-0-default"
CREATED_AT = "2026-10-22T09:00:00Z"


def rest(api, path):
    return f"{MICROCKS}/rest/{api.replace(' ', '+')}/1.0.0{path}"


LLM_URL = rest("LLM gateway", "/v1/chat/completions")

# The latency is carried by Microcks: services 6 s +-80 % (1.2 to 10.8 s), BODACC 20 s +-50 % (10 to 30 s), Company
# financials 45 s +-33 % (30 to 60 s), LLM 12 s +-50 % (6 to 18 s). The orchestrator mock draws in the same ranges.
SERVICE_DELAY = {"delay": 6000, "delayStrategy": "random-80"}
BODACC_DELAY = {"delay": 20000, "delayStrategy": "random-50"}
FINANCIALS_DELAY = {"delay": 45000, "delayStrategy": "random-33"}
LLM_DELAY = {"delay": 12000, "delayStrategy": "random-50"}
# Not in a contract: the orchestrator sends it as x-microcks-delay headers to the financial-health agent only.
FINANCIAL_HEALTH_HEADER_DELAY = {"delay": 50000, "delayStrategy": "random-20"}
SERVICE_SPREAD, BODACC_SPREAD, FINANCIALS_SPREAD, LLM_SPREAD, FINANCIAL_HEALTH_SPREAD = (
    int(x["delayStrategy"].split("-")[1])
    for x in (SERVICE_DELAY, BODACC_DELAY, FINANCIALS_DELAY, LLM_DELAY, FINANCIAL_HEALTH_HEADER_DELAY))
JITTER_MIN, JITTER_MAX = 300, 5000  # a ready step waits this long before it starts
LLM_SLOTS = 2  # at most two LLM calls at the same time; the other ready analyses are QUEUED

# --------------------------------------------------------------------------------------------------------------
# The five companies
# --------------------------------------------------------------------------------------------------------------

COMPANIES = {
    "100000001": {
        "slug": "boulangerie-la-rochelle",
        "name": "Boulangerie Les Délices du Port",
        "customer": {"customerId": "C-1001", "segment": "TPE", "customerSince": "2015-04-01", "declaredHeadcount": 8},
        "sirene": {"nafCode": "10.71C", "nafLabel": "Boulangerie et boulangerie-pâtisserie",
                   "headcountRange": "6 à 9 salariés", "creationDate": "2012-03-15",
                   "address": {"street": "12 quai Duperré", "postalCode": "17000", "city": "La Rochelle",
                               "inseeCityCode": "17300", "lat": 46.1591, "lon": -1.1520}},
        "bodacc": [{"type": "IMMATRICULATION", "nature": "Création d'un fonds de commerce de boulangerie",
                    "date": "2012-03-20", "court": "Tribunal de commerce de La Rochelle"}],
        "financials": {"year": 2025, "revenue": 640000, "netIncome": 38000, "equity": 210000, "debtRatio": 0.42,
                       "cashDays": 48},
        "openItems": {"openClaims": [{"claimId": "CLM-5101", "type": "DEGAT_DES_EAUX", "amount": 2400,
                                      "status": "OPEN", "litigation": False}],
                      "unpaidPremiums": 0, "pendingTermination": False},
        "risks": {"commune": "La Rochelle",
                  "risquesNaturels": {"inondation": {"present": True, "level": "MEDIUM"},
                                      "submersionMarine": {"present": True, "level": "HIGH"},
                                      "retraitGonflementArgiles": {"present": True, "level": "LOW"},
                                      "seisme": {"zone": 3},
                                      "feuxForet": {"present": False, "level": "NONE"}}},
        "llm": {
            "data-quality": {"status": "VALID", "score": 96, "issues": []},
            "climate-risk": {"level": "HIGH", "score": 78,
                             "drivers": ["Submersion marine forte (front de mer, quai Duperré)",
                                         "Inondation par débordement de niveau moyen",
                                         "Sismicité modérée (zone 3)"],
                             "rationale": "Le site est en zone de submersion marine forte : une tempête comme "
                                          "Xynthia exposerait le fournil et la chambre froide. Les autres aléas "
                                          "restent modérés."},
            "financial-health": {"level": "SOUND", "score": 74,
                                 "rationale": "Activité rentable (résultat net 38 k€ pour 640 k€ de CA), "
                                              "endettement maîtrisé à 42 % et 48 jours de trésorerie."},
            "open-items": {"complexity": "LOW", "manageable": True,
                           "rationale": "Un seul sinistre ouvert, un dégât des eaux de 2 400 € sans contentieux, "
                                        "et aucune prime impayée."},
            "verdict": {"decision": "ACCEPT_WITH_SURCHARGE", "surchargePercent": 15, "confidence": 0.86,
                        "rationale": ["Entreprise saine : rentable, peu endettée, données cohérentes.",
                                      "Exposition forte à la submersion marine sur le quai Duperré.",
                                      "Surprime de 15 % sur la garantie événements naturels recommandée."]},
        },
        "advisor": {"finalDecision": "ACCEPT",
                    "comment": "Batardeaux anti-submersion posés en 2024 et visite de risque favorable : "
                               "j'accepte sans surprime."},
    },
    "100000002": {
        "slug": "atelier-clermont",
        "name": "Atelier Mécanique Durand",
        "customer": {"customerId": "C-1002", "segment": "PME", "customerSince": "2009-09-15", "declaredHeadcount": 14},
        "sirene": {"nafCode": "33.12Z", "nafLabel": "Réparation de machines et équipements mécaniques",
                   "headcountRange": "10 à 19 salariés", "creationDate": "2004-06-01",
                   "address": {"street": "27 rue de l'Industrie", "postalCode": "63000", "city": "Clermont-Ferrand",
                               "inseeCityCode": "63113", "lat": 45.7772, "lon": 3.0870}},
        "bodacc": [{"type": "IMMATRICULATION", "nature": "Création d'un atelier de mécanique industrielle",
                    "date": "2004-06-10", "court": "Tribunal de commerce de Clermont-Ferrand"}],
        "financials": {"year": 2025, "revenue": 1850000, "netIncome": 142000, "equity": 690000, "debtRatio": 0.31,
                       "cashDays": 72},
        "openItems": {"openClaims": [], "unpaidPremiums": 0, "pendingTermination": False},
        "risks": {"commune": "Clermont-Ferrand",
                  "risquesNaturels": {"inondation": {"present": True, "level": "LOW"},
                                      "submersionMarine": {"present": False, "level": "NONE"},
                                      "retraitGonflementArgiles": {"present": True, "level": "LOW"},
                                      "seisme": {"zone": 3},
                                      "feuxForet": {"present": False, "level": "NONE"}}},
        "llm": {
            "data-quality": {"status": "VALID", "score": 98, "issues": []},
            "climate-risk": {"level": "LOW", "score": 18,
                             "drivers": ["Inondation faible", "Retrait-gonflement des argiles faible",
                                         "Sismicité modérée (zone 3)"],
                             "rationale": "Aucun aléa naturel marqué sur la zone d'activités : le risque climatique "
                                          "est faible."},
            "financial-health": {"level": "SOUND", "score": 85,
                                 "rationale": "Croissance rentable (142 k€ de résultat net), fonds propres solides "
                                              "et 72 jours de trésorerie."},
            "open-items": {"complexity": "LOW", "manageable": True,
                           "rationale": "Aucun sinistre ouvert, aucune prime impayée, aucune résiliation en cours."},
            "verdict": {"decision": "ACCEPT", "surchargePercent": 0, "confidence": 0.91,
                        "rationale": ["Entreprise saine et cliente depuis 2009.",
                                      "Risques naturels faibles sur le site.",
                                      "Aucun sinistre ni impayé : acceptation au tarif standard."]},
        },
        "advisor": {"finalDecision": "REVIEW",
                    "comment": "Extension d'atelier non déclarée vue sur place : je demande une visite de risque "
                               "avant d'engager."},
    },
    "100000003": {
        "slug": "transports-lille",
        "name": "Transports Express Nord",
        "customer": {"customerId": "C-1003", "segment": "PME", "customerSince": "2011-01-10", "declaredHeadcount": 42},
        "sirene": {"nafCode": "49.41A", "nafLabel": "Transports routiers de fret interurbains",
                   "headcountRange": "20 à 49 salariés", "creationDate": "2009-02-02",
                   "address": {"street": "8 avenue de la Marne", "postalCode": "59000", "city": "Lille",
                               "inseeCityCode": "59350", "lat": 50.6292, "lon": 3.0573}},
        "bodacc": [{"type": "PROCEDURE_COLLECTIVE",
                    "nature": "Jugement d'ouverture d'une procédure de redressement judiciaire",
                    "date": "2026-09-08", "court": "Tribunal de commerce de Lille Métropole"},
                   {"type": "IMMATRICULATION", "nature": "Création d'une entreprise de transport routier",
                    "date": "2009-02-10", "court": "Tribunal de commerce de Lille Métropole"}],
        "financials": {"year": 2025, "revenue": 4200000, "netIncome": -610000, "equity": -150000,
                       "debtRatio": 1.35, "cashDays": 6},
        "openItems": {"openClaims": [{"claimId": "CLM-5301", "type": "FLOTTE_AUTOMOBILE", "amount": 18500,
                                      "status": "OPEN", "litigation": False}],
                      "unpaidPremiums": 4200, "pendingTermination": True},
        "risks": {"commune": "Lille",
                  "risquesNaturels": {"inondation": {"present": True, "level": "MEDIUM"},
                                      "submersionMarine": {"present": False, "level": "NONE"},
                                      "retraitGonflementArgiles": {"present": True, "level": "MEDIUM"},
                                      "seisme": {"zone": 2},
                                      "feuxForet": {"present": False, "level": "NONE"}}},
        "llm": None,
        "advisor": {"finalDecision": "REVIEW",
                    "comment": "L'administrateur judiciaire présente un plan de continuation : je transmets au "
                               "service contentieux pour revue."},
    },
    "100000004": {
        "slug": "restaurant-avignon",
        "name": "Restaurant Le Vieux Moulin",
        "customer": {"customerId": "C-1004", "segment": "TPE", "customerSince": "2017-05-20", "declaredHeadcount": 35},
        "sirene": {"nafCode": "56.10A", "nafLabel": "Restauration traditionnelle",
                   "headcountRange": "6 à 9 salariés", "creationDate": "2016-11-03",
                   "address": {"street": "5 rue du Rempart Saint-Lazare", "postalCode": "84000", "city": "Avignon",
                               "inseeCityCode": "84007", "lat": 43.9493, "lon": 4.8055}},
        "bodacc": [{"type": "IMMATRICULATION", "nature": "Création d'un fonds de restauration traditionnelle",
                    "date": "2016-11-15", "court": "Tribunal de commerce d'Avignon"}],
        "financials": {"year": 2025, "revenue": 520000, "netIncome": -24000, "equity": 31000, "debtRatio": 0.88,
                       "cashDays": 11},
        "openItems": {"openClaims": [{"claimId": "CLM-5401", "type": "DEGAT_DES_EAUX", "amount": 6800,
                                      "status": "OPEN", "litigation": False},
                                     {"claimId": "CLM-5402", "type": "RESPONSABILITE_CIVILE", "amount": 23000,
                                      "status": "OPEN", "litigation": True},
                                     {"claimId": "CLM-5403", "type": "BRIS_DE_GLACE", "amount": 1900,
                                      "status": "OPEN", "litigation": False}],
                      "unpaidPremiums": 1250, "pendingTermination": False},
        "risks": {"commune": "Avignon",
                  "risquesNaturels": {"inondation": {"present": True, "level": "MEDIUM"},
                                      "submersionMarine": {"present": False, "level": "NONE"},
                                      "retraitGonflementArgiles": {"present": True, "level": "HIGH"},
                                      "seisme": {"zone": 3},
                                      "feuxForet": {"present": True, "level": "LOW"}}},
        "llm": {
            "data-quality": {"status": "WARNINGS", "score": 61,
                             "issues": ["Effectif déclaré au CRM (35) incohérent avec la tranche Sirene "
                                        "(6 à 9 salariés).",
                                        "Fonds propres faibles (31 k€) au regard du chiffre d'affaires."]},
            "climate-risk": {"level": "HIGH", "score": 72,
                             "drivers": ["Retrait-gonflement des argiles fort",
                                         "Inondation de niveau moyen (crues du Rhône)",
                                         "Sismicité modérée (zone 3)"],
                             "rationale": "Le bâtiment ancien sur sol argileux est exposé aux fissures en période "
                                          "de sécheresse, et le quartier est en zone inondable moyenne."},
            "financial-health": {"level": "FRAGILE", "score": 38,
                                 "rationale": "Exercice déficitaire (-24 k€), endettement à 88 % et seulement "
                                              "11 jours de trésorerie."},
            "open-items": {"complexity": "HIGH", "manageable": False,
                           "rationale": "Trois sinistres ouverts dont une responsabilité civile de 23 000 € en "
                                        "contentieux, et 1 250 € de primes impayées."},
            "verdict": {"decision": "REVIEW", "surchargePercent": 0, "confidence": 0.58,
                        "rationale": ["Situation financière fragile et données déclarées incohérentes.",
                                      "Trois sinistres ouverts dont un en contentieux.",
                                      "Argiles fort : visite de risque nécessaire.",
                                      "Décision à prendre par un souscripteur après revue du dossier."]},
        },
        "advisor": {"finalDecision": "REFUSE",
                    "comment": "Contentieux en responsabilité civile et effectif non justifié : je refuse."},
    },
}
UNKNOWN_SIREN = "999999999"
ALL_SIRENS = list(COMPANIES) + [UNKNOWN_SIREN]
LLM_SIRENS = [s for s, c in COMPANIES.items() if c["llm"]]
AGENTS = ["data-quality", "climate-risk", "financial-health", "open-items", "verdict"]

# --------------------------------------------------------------------------------------------------------------
# A tiny YAML writer (no dependency)
# --------------------------------------------------------------------------------------------------------------

PLAIN = re.compile(r"^[A-Za-z_][A-Za-z0-9_.\-/]*( [A-Za-z0-9_.\-/]+)*$")
RESERVED = {"true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"}


def scalar(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if PLAIN.match(v) and v.lower() not in RESERVED:
        return v
    return json.dumps(v, ensure_ascii=False)


def emit(obj, indent=0):
    pad = " " * indent
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = scalar(str(k))
            out.extend(entry(pad + key + ":", v, indent))
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, dict) and item:
                sub = emit(item, indent + 2)
                out.append(pad + "- " + sub[0].lstrip())
                out.extend(sub[1:])
            else:
                out.extend(entry(pad + "-", item, indent))
    return out


def entry(head, v, indent):
    if isinstance(v, str) and "\n" in v:
        lines = [head + " |" + ("" if v.endswith("\n") else "-")]
        lines += [(" " * (indent + 2) + line) if line else "" for line in v.rstrip("\n").split("\n")]
        return lines
    if isinstance(v, dict):
        return [head + " {}"] if not v else [head] + emit(v, indent + 2)
    if isinstance(v, list):
        return [head + " []"] if not v else [head] + emit(v, indent + 2)
    return [head + " " + scalar(v)]


def write(name, doc, header=None):
    text = "\n".join(emit(doc)) + "\n"
    if header:
        text = "".join("# " + line + "\n" for line in header.split("\n")) + text
    (CONTRACTS / name).write_text(text, encoding="utf-8")
    print("wrote contracts/" + name)


# --------------------------------------------------------------------------------------------------------------
# Helpers to build OpenAPI documents
# --------------------------------------------------------------------------------------------------------------

def openapi(title, description, paths, schemas):
    return {"openapi": "3.0.3",
            "info": {"title": title, "version": "1.0.0", "description": description},
            "paths": paths,
            "components": {"schemas": schemas}}


def param(name, where, examples, description=None):
    p = {"name": name, "in": where, "required": True, "schema": {"type": "string"}}
    if description:
        p["description"] = description
    p["examples"] = {k: {"value": v} for k, v in examples.items()}
    return p


def json_content(schema_ref, examples):
    return {"application/json": {"schema": {"$ref": "#/components/schemas/" + schema_ref},
                                 "examples": {k: {"value": v} for k, v in examples.items()}}}


def error_schema():
    return {"type": "object", "required": ["code"],
            "properties": {"code": {"type": "string"}, "message": {"type": "string"}}}


def obj(props, required=None):
    s = {"type": "object", "properties": props}
    s["required"] = required if required is not None else list(props)
    return s


STR = {"type": "string"}
INT = {"type": "integer"}
NUM = {"type": "number"}
BOOL = {"type": "boolean"}
LEVEL = {"type": "string", "enum": ["NONE", "LOW", "MEDIUM", "HIGH"]}


def ex(siren):
    return "siren-" + siren


# --------------------------------------------------------------------------------------------------------------
# The seven APIs called by the orchestrator
# --------------------------------------------------------------------------------------------------------------

def customer_body(siren):
    c = COMPANIES[siren]
    return {"customerId": c["customer"]["customerId"], "siren": siren, "name": c["name"],
            "segment": c["customer"]["segment"], "customerSince": c["customer"]["customerSince"],
            "declaredHeadcount": c["customer"]["declaredHeadcount"]}


NOT_FOUND_CUSTOMER = {"code": "CUSTOMER_NOT_FOUND", "message": "Aucun compte client pour le SIREN 999999999."}


def customer_accounts():
    found = {ex(s): customer_body(s) for s in COMPANIES}
    return openapi(
        "Customer accounts",
        "CRM interne : retrouve le compte client d'une entreprise par son SIREN. Le SIREN 999999999 n'a pas de "
        "compte (404).",
        {"/customers/by-siren/{siren}": {"get": {
            "operationId": "getCustomerBySiren",
            "summary": "Retrouver un compte client par SIREN",
            "parameters": [param("siren", "path", {**{ex(s): s for s in COMPANIES},
                                                   "unknown-" + UNKNOWN_SIREN: UNKNOWN_SIREN})],
            "x-microcks-operation": {**SERVICE_DELAY, "dispatcher": "URI_PARTS", "dispatcherRules": "siren"},
            "responses": {
                "200": {"description": "Le compte client", "content": json_content("Customer", found)},
                "404": {"description": "Aucun compte client pour ce SIREN",
                        "content": json_content("Error", {"unknown-" + UNKNOWN_SIREN: NOT_FOUND_CUSTOMER})}}}}},
        {"Customer": obj({"customerId": STR, "siren": STR, "name": STR,
                          "segment": {"type": "string", "enum": ["TPE", "PME", "ETI"]},
                          "customerSince": {"type": "string", "format": "date"}, "declaredHeadcount": INT}),
         "Error": error_schema()})


def sirene_body(siren):
    c = COMPANIES[siren]
    s = c["sirene"]
    return {"siren": siren, "denomination": c["name"], "nafCode": s["nafCode"], "nafLabel": s["nafLabel"],
            "headcountRange": s["headcountRange"], "creationDate": s["creationDate"], "active": True,
            "address": dict(s["address"])}


def sirene():
    return openapi(
        "Sirene",
        "Identité des entreprises (inspirée de l'API Sirene de l'INSEE), simplifiée pour la démo.",
        {"/siren/{siren}": {"get": {
            "operationId": "getUniteLegale",
            "summary": "Identité d'une entreprise par SIREN",
            "parameters": [param("siren", "path", {ex(s): s for s in COMPANIES})],
            "x-microcks-operation": {**SERVICE_DELAY, "dispatcher": "URI_PARTS", "dispatcherRules": "siren"},
            "responses": {"200": {"description": "L'unité légale",
                                  "content": json_content("UniteLegale", {ex(s): sirene_body(s) for s in COMPANIES})}}}}},
        {"UniteLegale": obj({"siren": STR, "denomination": STR, "nafCode": STR, "nafLabel": STR,
                             "headcountRange": STR, "creationDate": {"type": "string", "format": "date"},
                             "active": BOOL, "address": {"$ref": "#/components/schemas/Address"}}),
         "Address": obj({"street": STR, "postalCode": STR, "city": STR, "inseeCityCode": STR, "lat": NUM,
                         "lon": NUM})})


def bodacc_body(siren):
    records = COMPANIES[siren]["bodacc"]
    return {"total": len(records), "records": records}


def bodacc():
    return openapi(
        "BODACC",
        "Annonces légales (inspirées de l'API BODACC), filtrées par SIREN. Transports Express Nord (100000003) a un "
        "jugement de redressement judiciaire.",
        {"/annonces": {"get": {
            "operationId": "searchAnnonces",
            "summary": "Annonces BODACC d'une entreprise",
            "parameters": [param("siren", "query", {ex(s): s for s in COMPANIES})],
            "x-microcks-operation": {**BODACC_DELAY, "dispatcher": "URI_PARAMS", "dispatcherRules": "siren"},
            "responses": {"200": {"description": "Les annonces",
                                  "content": json_content("Annonces", {ex(s): bodacc_body(s) for s in COMPANIES})}}}}},
        {"Annonces": obj({"total": INT, "records": {"type": "array", "items": {"$ref": "#/components/schemas/Annonce"}}}),
         "Annonce": obj({"type": {"type": "string", "enum": ["IMMATRICULATION", "MODIFICATION", "PROCEDURE_COLLECTIVE",
                                                            "RADIATION", "DEPOT_DES_COMPTES"]},
                         "nature": STR, "date": {"type": "string", "format": "date"}, "court": STR})})


def latlon(siren):
    a = COMPANIES[siren]["sirene"]["address"]
    return f"{a['lon']:.4f},{a['lat']:.4f}"


def insee(siren):
    return COMPANIES[siren]["sirene"]["address"]["inseeCityCode"]


def georisques():
    examples = {"insee-" + insee(s): s for s in COMPANIES}
    georisques_script = (
        "def codeInsee = mockRequest.getRequest()?.getParameter(\"code_insee\")\n"
        f"if ({json.dumps([insee(s) for s in COMPANIES])}.contains(codeInsee)) {{\n"
        "   return \"insee-\" + codeInsee\n"
        "}\n"
        "return \"unknown\"\n")
    return openapi(
        "Georisques",
        "Risques naturels d'une adresse (inspiré du rapport de risques de Géorisques), simplifié pour la démo. "
        "Le mock répond selon code_insee ; latlon (longitude,latitude) est accepté tel quel. Exposé aussi en MCP "
        "par Microcks.",
        {"/resultats_rapport_risque": {"get": {
            "operationId": "getRapportRisque",
            "summary": "Rapport des risques naturels d'une commune et d'un point",
            "description": "Renvoie les risques naturels connus pour une commune (code INSEE) et un point "
                           "(longitude,latitude).",
            "parameters": [
                param("code_insee", "query", {k: insee(s) for k, s in examples.items()},
                      "Code INSEE de la commune, par exemple 17300."),
                param("latlon", "query", {k: latlon(s) for k, s in examples.items()},
                      "Longitude et latitude séparées par une virgule, par exemple -1.152,46.1591.")],
            # SCRIPT rather than URI_PARAMS: with URI_PARAMS, the MCP tools/call of Microcks doubles the query
            # string when it computes the dispatch criteria (BasicHttpServletRequest.getRequestURL already holds it),
            # so no example matches. getParameter works both for REST and for MCP.
            "x-microcks-operation": {**SERVICE_DELAY, "dispatcher": "SCRIPT", "dispatcherRules": georisques_script},
            "responses": {"200": {"description": "Le rapport de risques",
                                  "content": json_content("RapportRisque",
                                                          {k: COMPANIES[s]["risks"] for k, s in examples.items()})}}}}},
        {"RapportRisque": obj({"commune": STR, "risquesNaturels": obj({
            "inondation": {"$ref": "#/components/schemas/Alea"},
            "submersionMarine": {"$ref": "#/components/schemas/Alea"},
            "retraitGonflementArgiles": {"$ref": "#/components/schemas/Alea"},
            "seisme": obj({"zone": {"type": "integer", "minimum": 1, "maximum": 5}}),
            "feuxForet": {"$ref": "#/components/schemas/Alea"}})}),
         "Alea": obj({"present": BOOL, "level": LEVEL})})


def financials_body(siren):
    return {"siren": siren, **COMPANIES[siren]["financials"]}


def company_financials():
    return openapi(
        "Company financials",
        "Derniers comptes annuels d'une entreprise (inspirés des données de la Banque de France), simplifiés.",
        {"/companies/{siren}/financials": {"get": {
            "operationId": "getFinancials",
            "summary": "Derniers comptes annuels d'une entreprise",
            "parameters": [param("siren", "path", {ex(s): s for s in COMPANIES})],
            "x-microcks-operation": {**FINANCIALS_DELAY, "dispatcher": "URI_PARTS", "dispatcherRules": "siren"},
            "responses": {"200": {"description": "Les comptes annuels",
                                  "content": json_content("Financials", {ex(s): financials_body(s) for s in COMPANIES})}}}}},
        {"Financials": obj({"siren": STR, "year": INT, "revenue": NUM, "netIncome": NUM, "equity": NUM,
                            "debtRatio": NUM, "cashDays": INT})})


def open_items_body(siren):
    c = COMPANIES[siren]
    return {"customerId": c["customer"]["customerId"], **c["openItems"]}


def customer_id(siren):
    return COMPANIES[siren]["customer"]["customerId"]


def claims_and_contracts():
    names = {"customer-" + customer_id(s): s for s in COMPANIES}
    return openapi(
        "Claims and contracts",
        "Sinistres et contrats internes : les points ouverts d'un client (sinistres, primes impayées, résiliation).",
        {"/customers/{customerId}/open-items": {"get": {
            "operationId": "getOpenItems",
            "summary": "Points ouverts d'un client",
            "parameters": [param("customerId", "path", {k: customer_id(s) for k, s in names.items()})],
            "x-microcks-operation": {**SERVICE_DELAY, "dispatcher": "URI_PARTS", "dispatcherRules": "customerId"},
            "responses": {"200": {"description": "Les points ouverts du client",
                                  "content": json_content("OpenItems", {k: open_items_body(s) for k, s in names.items()})}}}}},
        {"OpenItems": obj({"customerId": STR,
                           "openClaims": {"type": "array", "items": {"$ref": "#/components/schemas/Claim"}},
                           "unpaidPremiums": NUM, "pendingTermination": BOOL}),
         "Claim": obj({"claimId": STR, "type": STR, "amount": NUM,
                       "status": {"type": "string", "enum": ["OPEN", "CLOSED"]}, "litigation": BOOL})})


# --------------------------------------------------------------------------------------------------------------
# The LLM gateway
# --------------------------------------------------------------------------------------------------------------

SYSTEM_PROMPTS = {
    "data-quality": "Tu es l'agent qualité des données d'un assureur. Compare les données du CRM, de Sirene et des "
                    "comptes. Réponds en JSON : status, score, issues.",
    "climate-risk": "Tu es l'agent risque climatique d'un assureur. Appelle l'outil get_resultats_rapport_risque "
                    "pour obtenir les risques naturels du site, puis évalue son exposition. Réponds en JSON : level, score, drivers, rationale.",
    "financial-health": "Tu es l'agent santé financière d'un assureur. À partir des comptes annuels, évalue la "
                        "solidité de l'entreprise. Réponds en JSON : level, score, rationale.",
    "open-items": "Tu es l'agent sinistres et contrats d'un assureur. Évalue les points ouverts du client. Réponds en "
                  "JSON : complexity, manageable, rationale.",
    "verdict": "Tu es le copilote souscription d'un assureur. À partir des sorties des quatre agents, donne un avis "
               "Multirisque Pro. Réponds en JSON : decision, surchargePercent, confidence, rationale.",
}


def llm_user_content(agent, siren):
    c = COMPANIES[siren]
    if agent == "data-quality":
        data = {"crm": customer_body(siren), "sirene": sirene_body(siren), "financials": financials_body(siren)}
    elif agent == "climate-risk":
        data = {"address": c["sirene"]["address"]}
    elif agent == "financial-health":
        data = financials_body(siren)
    elif agent == "open-items":
        data = open_items_body(siren)
    else:
        data = {a: c["llm"][a] for a in AGENTS if a != "verdict"}
    return json.dumps({"siren": siren, "company": c["name"], "data": data}, ensure_ascii=False)


GEORISQUES_TOOL = {"type": "function", "function": {
    "name": "get_resultats_rapport_risque",
    "description": "Renvoie les risques naturels connus pour une commune (code INSEE) et un point (longitude,latitude).",
    "parameters": {"type": "object",
                   "properties": {"code_insee": {"type": "string", "description": "Code INSEE de la commune, par exemple 17300."},
                                  "latlon": {"type": "string", "description": "Longitude et latitude séparées par une virgule, par exemple -1.152,46.1591."}},
                   "required": ["code_insee", "latlon"], "additionalProperties": False}}}


def tool_call(siren):
    return {"id": f"call_georisques_{siren}", "type": "function",
            "function": {"name": "get_resultats_rapport_risque",
                         "arguments": json.dumps({"code_insee": insee(siren), "latlon": latlon(siren)},
                                                    separators=(",", ":"))}}


def completion(name, created, prompt, message, finish_reason):
    completion_tokens = 20 + len(json.dumps(message, ensure_ascii=False)) // 4
    prompt_tokens = 180 + prompt // 4
    return {"id": f"chatcmpl-demo-{name}", "object": "chat.completion", "created": created,
            "model": "gpt-4o-mini-2024-07-18",
            "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
            "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
                      "total_tokens": prompt_tokens + completion_tokens}}


def llm_gateway():
    req, res = {}, {}
    for siren in LLM_SIRENS:
        for i, agent in enumerate(AGENTS):
            name = f"{agent}-{siren}"
            messages = [{"role": "system", "content": SYSTEM_PROMPTS[agent]},
                        {"role": "user", "content": llm_user_content(agent, siren)}]
            base = {"model": "gpt-4o-mini", "messages": messages, "response_format": {"type": "json_object"},
                    "metadata": {"agent": agent, "siren": siren}}
            if agent == "climate-risk":
                # First turn: the model asks for the Georisques tool (exposed in MCP by reShapr).
                req[name + "-tool-call"] = {**base, "tools": [GEORISQUES_TOOL]}
                res[name + "-tool-call"] = completion(
                    name + "-tool-call", 1792656000 + i, len(messages[1]["content"]),
                    {"role": "assistant", "content": None, "tool_calls": [tool_call(siren)]}, "tool_calls")
                # Second turn: the tool result is in a role: tool message, the model answers.
                messages = messages + [
                    {"role": "assistant", "content": None, "tool_calls": [tool_call(siren)]},
                    {"role": "tool", "tool_call_id": tool_call(siren)["id"],
                     "content": json.dumps(COMPANIES[siren]["risks"], ensure_ascii=False)}]
                base = {**base, "messages": messages, "tools": [GEORISQUES_TOOL]}
            req[name] = base
            content = json.dumps(COMPANIES[siren]["llm"][agent], ensure_ascii=False)
            res[name] = completion(name, 1792656100 + i, sum(len(m["content"] or "") for m in messages),
                                   {"role": "assistant", "content": content}, "stop")
    req["unsupported"] = {"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Bonjour"}],
                          "metadata": {"agent": "unknown-agent", "siren": "000000000"}}
    script = (
        "def body = new groovy.json.JsonSlurper().parseText(mockRequest.getRequestContent() ?: \"{}\")\n"
        "def agent = body?.metadata?.agent\n"
        "def siren = body?.metadata?.siren\n"
        f"def agents = {json.dumps(AGENTS)}\n"
        f"def sirens = {json.dumps(LLM_SIRENS)}\n"
        "if (!agents.contains(agent) || !sirens.contains(siren)) {\n"
        "   return \"unsupported\"\n"
        "}\n"
        "// The climate agent first asks for the Georisques tool, until a role: tool message brings its result.\n"
        "if (agent == \"climate-risk\" && !(body?.messages ?: []).any { it?.role == \"tool\" }) {\n"
        "   return agent + \"-\" + siren + \"-tool-call\"\n"
        "}\n"
        "return agent + \"-\" + siren\n")
    ref = lambda n: {"$ref": "#/components/schemas/" + n}
    return openapi(
        "LLM gateway",
        "Passerelle LLM compatible OpenAI Chat Completions. Le mock Microcks répond selon metadata.agent et "
        "metadata.siren du corps (exemple <agent>-<siren>) ; la sortie structurée de l'agent est la chaîne JSON de "
        "choices[0].message.content. L'agent climate-risk appelle un outil : tant que la requête ne contient aucun "
        "message role: tool, la réponse est un tool_calls get_resultats_rapport_risque (exemple "
        "climate-risk-<siren>-tool-call, finish_reason tool_calls) ; ensuite, la réponse finale.",
        {"/v1/chat/completions": {"post": {
            "operationId": "createChatCompletion",
            "summary": "Créer une complétion de chat (compatible OpenAI)",
            "x-microcks-operation": {**LLM_DELAY, "dispatcher": "SCRIPT", "dispatcherRules": script},
            "requestBody": {"required": True, "content": json_content("ChatCompletionRequest", req)},
            "responses": {
                "200": {"description": "La complétion",
                        "content": json_content("ChatCompletion", {k: v for k, v in res.items()})},
                "400": {"description": "Agent ou SIREN sans réponse enregistrée",
                        "content": json_content("OpenAIError", {"unsupported": {"error": {
                            "message": "Aucune réponse enregistrée pour cet agent et ce SIREN.",
                            "type": "invalid_request_error", "code": "unsupported_metadata"}}})}}}}},
        {"ChatCompletionRequest": obj({
            "model": STR, "messages": {"type": "array", "items": ref("Message")},
            "tools": {"type": "array", "items": ref("Tool")},
            "response_format": obj({"type": STR}),
            "metadata": obj({"agent": STR, "siren": STR})}, ["model", "messages", "metadata"]),
         "Message": obj({"role": {"type": "string", "enum": ["system", "user", "assistant", "tool"]},
                         "content": {"type": "string", "nullable": True},
                         "tool_calls": {"type": "array", "items": ref("ToolCall")},
                         "tool_call_id": STR}, ["role"]),
         "Tool": obj({"type": {"type": "string", "enum": ["function"]},
                      "function": obj({"name": STR, "description": STR, "parameters": {"type": "object"}},
                                      ["name"])}),
         "ToolCall": obj({"id": STR, "type": {"type": "string", "enum": ["function"]},
                          "function": obj({"name": STR, "arguments": STR})}),
         "ChatCompletion": obj({
             "id": STR, "object": STR, "created": INT, "model": STR,
             "choices": {"type": "array", "items": obj({"index": INT, "message": ref("Message"),
                                                        "finish_reason": {"type": "string",
                                                                          "enum": ["stop", "tool_calls", "length"]}})},
             "usage": obj({"prompt_tokens": INT, "completion_tokens": INT, "total_tokens": INT})}),
         "OpenAIError": obj({"error": obj({"message": STR, "type": STR, "code": STR})})})


# --------------------------------------------------------------------------------------------------------------
# The orchestrator: Underwriting cases, with its stateful mock
# --------------------------------------------------------------------------------------------------------------

COLLECTION = ["companyIdentity", "legalEvents", "financials", "openItems"]
STEPS = [  # stepId, label, phase, mode, kind, dependsOn
    ("checkAccount", "Compte client", 1, "CHAIN", "SERVICE", []),
    ("companyIdentity", "Identité de l'entreprise (Sirene)", 2, "PARALLEL", "SERVICE", ["checkAccount"]),
    ("legalEvents", "Annonces légales (BODACC)", 2, "PARALLEL", "SERVICE", ["checkAccount"]),
    ("financials", "Comptes annuels", 2, "PARALLEL", "SERVICE", ["checkAccount"]),
    ("openItems", "Sinistres et contrats", 2, "PARALLEL", "SERVICE", ["checkAccount"]),
    ("dataQuality", "Contrôle de la qualité des données", 2, "CHAIN", "LLM",
     ["checkAccount", "companyIdentity", "financials"]),
    ("dataReview", "Validation des données par le conseiller", 3, "CHAIN", "HUMAN", COLLECTION + ["dataQuality"]),
    ("climateRisk", "Analyse du risque climatique (outil Géorisques via MCP)", 4, "PARALLEL", "LLM",
     ["companyIdentity", "dataQuality"]),
    ("financialHealth", "Analyse de la santé financière", 4, "PARALLEL", "LLM",
     ["financials", "legalEvents", "dataReview"]),
    ("openItemsReview", "Analyse des sinistres et contrats", 4, "PARALLEL", "LLM", ["openItems", "dataQuality"]),
    ("synthesis", "Synthèse des analyses (consultative)", 5, "CHAIN", "LLM",
     ["climateRisk", "financialHealth", "openItemsReview", "dataReview"]),
    ("advisorDecision", "Décision du conseiller", 6, "CHAIN", "HUMAN", ["synthesis"]),
]
STEP_AGENT = {"dataQuality": "data-quality", "climateRisk": "climate-risk", "financialHealth": "financial-health",
              "openItemsReview": "open-items", "synthesis": "verdict"}


def at(ms):
    return f"2026-10-22T09:00:{ms // 1000:02d}.{ms % 1000:03d}Z"


def keur(v):
    return f"{v / 1000:.0f} k€".replace("-", "-")


def fr_amount(v):
    return f"{v:,}".replace(",", " ") + " €"


LEVEL_FR = {"NONE": "nul", "LOW": "faible", "MEDIUM": "moyen", "HIGH": "fort"}
DECISION_FR = {"ACCEPT": "acceptation au tarif standard",
               "ACCEPT_WITH_SURCHARGE": "acceptation avec surprime",
               "REVIEW": "revue par un souscripteur",
               "REFUSE": "refus",
               "NOT_ELIGIBLE": "non éligible"}
CLAIM_FR = {"DEGAT_DES_EAUX": "dégât des eaux", "RESPONSABILITE_CIVILE": "responsabilité civile",
            "BRIS_DE_GLACE": "bris de glace", "FLOTTE_AUTOMOBILE": "flotte automobile"}


def done_step(siren, step_id):
    """What a step holds once done: summary, result and the calls it made."""
    c = COMPANIES.get(siren)
    if step_id == "checkAccount":
        url = rest("Customer accounts", f"/customers/by-siren/{siren}")
        if c is None:
            return (f"Aucun compte client pour le SIREN {siren} : dossier non éligible.", NOT_FOUND_CUSTOMER,
                    [call("GET", url, 404, "REST")])
        cu = c["customer"]
        return (f"Client {cu['customerId']} trouvé : {c['name']}, client depuis {cu['customerSince'][:4]}.",
                customer_body(siren), [call("GET", url, 200, "REST")])
    if step_id == "companyIdentity":
        s = c["sirene"]
        return (f"Entreprise active, NAF {s['nafCode']} ({s['nafLabel']}), {s['headcountRange']}, "
                f"{s['address']['city']}.", sirene_body(siren),
                [call("GET", rest("Sirene", f"/siren/{siren}"), 200, "REST")])
    if step_id == "legalEvents":
        procedures = [r for r in c["bodacc"] if r["type"] == "PROCEDURE_COLLECTIVE"]
        if procedures:
            p = procedures[0]
            summary = (f"Procédure collective au BODACC : {p['nature'].lower()} le {fr_date(p['date'])} "
                       f"({p['court']}).")
        else:
            summary = f"Aucune procédure collective au BODACC ({len(c['bodacc'])} annonce : immatriculation)."
        return summary, bodacc_body(siren), [call("GET", rest("BODACC", f"/annonces?siren={siren}"), 200, "REST")]
    if step_id == "financials":
        f = c["financials"]
        return (f"Exercice {f['year']} : CA {keur(f['revenue'])}, résultat {keur(f['netIncome'])}, endettement "
                f"{round(f['debtRatio'] * 100)} %, trésorerie {f['cashDays']} jours.", financials_body(siren),
                [call("GET", rest("Company financials", f"/companies/{siren}/financials"), 200, "REST")])
    if step_id == "openItems":
        o = c["openItems"]
        claims = o["openClaims"]
        if not claims:
            summary = "Aucun sinistre ouvert, aucune prime impayée."
        else:
            parts = ", ".join(f"{CLAIM_FR[cl['type']]} {fr_amount(cl['amount'])}"
                              + (" en contentieux" if cl["litigation"] else "") for cl in claims)
            summary = f"{len(claims)} sinistre{'s' if len(claims) > 1 else ''} ouvert{'s' if len(claims) > 1 else ''} ({parts})"
            summary += f", {fr_amount(o['unpaidPremiums'])} de primes impayées" if o["unpaidPremiums"] else \
                ", aucune prime impayée"
            summary += ", résiliation en cours." if o["pendingTermination"] else "."
        return summary, open_items_body(siren), [
            call("GET", rest("Claims and contracts", f"/customers/{customer_id(siren)}/open-items"), 200, "REST")]
    if step_id == "synthesis" and not c["llm"]:
        return ("Règle de souscription : procédure collective, suggestion de refus sans aucune analyse LLM.",
                {"decision": "REFUSE", "rule": "COLLECTIVE_PROCEDURE"}, [])
    agent = STEP_AGENT[step_id]
    out = c["llm"][agent]
    summaries = {
        "data-quality": lambda o: f"Données {'cohérentes' if o['status'] == 'VALID' else 'à vérifier'} "
                                  f"(score {o['score']}/100)" + (f" : {o['issues'][0]}" if o["issues"] else "."),
        "climate-risk": lambda o: f"Risque climatique {o['level']} (score {o['score']}/100) : "
                                  f"{o['drivers'][0].lower()} (Géorisques interrogé par l'outil MCP).",
        "financial-health": lambda o: f"Santé financière {o['level']} (score {o['score']}/100).",
        "open-items": lambda o: f"Sinistres et contrats : complexité {o['complexity']}, "
                                f"{'gérable' if o['manageable'] else 'non gérable'} en l'état.",
        "verdict": lambda o: f"Suggestion consultative : {DECISION_FR[o['decision']]}"
                             + (f" de {o['surchargePercent']} %" if o["surchargePercent"] else "")
                             + f" (confiance {round(o['confidence'] * 100)} %).",
    }
    if step_id == "climateRisk":
        # The agent loop: MCP tools/list, LLM (tool_calls), MCP tools/call (reShapr calls Georisques), LLM (answer).
        calls = [call("POST", MCP_URL, 200, "MCP"), call("POST", LLM_URL, 200, "LLM"),
                 call("POST", MCP_URL, 200, "MCP"), call("POST", LLM_URL, 200, "LLM")]
        return summaries[agent](out), {**out, "naturalRisks": c["risks"]}, calls
    return summaries[agent](out), out, [call("POST", LLM_URL, 200, "LLM")]


def fr_date(iso):
    y, m, d = iso.split("-")
    return f"{d}/{m}/{y}"


def call(method, url, status, via):
    return {"method": method, "url": url, "status": status, "via": via}


def recommendation(siren):
    c = COMPANIES.get(siren)
    if c is None:
        return {"decision": "NOT_ELIGIBLE", "surchargePercent": 0, "confidence": 1.0,
                "rationale": [f"Aucun compte client pour le SIREN {siren}.",
                              "Règle de souscription : seul un client connu peut ouvrir un dossier Multirisque Pro."],
                "source": "RULE"}
    if not c["llm"]:
        p = [r for r in c["bodacc"] if r["type"] == "PROCEDURE_COLLECTIVE"][0]
        return {"decision": "REFUSE", "surchargePercent": 0, "confidence": 1.0,
                "rationale": [f"Redressement judiciaire publié au BODACC le {fr_date(p['date'])} ({p['court']}).",
                              "Règle de souscription : suggestion de refus, aucune analyse LLM sollicitée."],
                "source": "RULE"}
    v = c["llm"]["verdict"]
    return {"decision": v["decision"], "surchargePercent": v["surchargePercent"], "confidence": v["confidence"],
            "rationale": v["rationale"], "source": "LLM"}


REASON_ORDER = ["UNKNOWN_CUSTOMER", "COLLECTIVE_PROCEDURE", "CLIMATE_HIGH", "FINANCIAL_FRAGILE", "OPEN_LITIGATION",
                "DATA_INCONSISTENT"]


def risk_reasons(siren):
    """The deterministic risk reasons of a case, before any correction of the advisor."""
    c = COMPANIES.get(siren)
    if c is None:
        return [{"code": "UNKNOWN_CUSTOMER", "label": f"Aucun compte client pour le SIREN {siren}",
                 "stepId": "checkAccount"}]
    reasons = []
    for p in [r for r in c["bodacc"] if r["type"] == "PROCEDURE_COLLECTIVE"]:
        reasons.append({"code": "COLLECTIVE_PROCEDURE",
                        "label": f"Procédure collective au BODACC : {p['nature'].lower()} du {fr_date(p['date'])}",
                        "stepId": "legalEvents"})
    llm = c["llm"] or {}
    if llm and llm["climate-risk"]["level"] in ("HIGH", "VERY_HIGH"):
        reasons.append({"code": "CLIMATE_HIGH",
                        "label": f"Risque climatique élevé : {llm['climate-risk']['drivers'][0].lower()}",
                        "stepId": "climateRisk"})
    if llm and llm["financial-health"]["level"] in ("FRAGILE", "CRITICAL"):
        f = c["financials"]
        reasons.append({"code": "FINANCIAL_FRAGILE",
                        "label": f"Santé financière fragile : résultat {keur(f['netIncome'])}, endettement "
                                 f"{round(f['debtRatio'] * 100)} %, trésorerie {f['cashDays']} jours",
                        "stepId": "financialHealth"})
    for cl in [cl for cl in c["openItems"]["openClaims"] if cl["litigation"]]:
        reasons.append({"code": "OPEN_LITIGATION",
                        "label": f"Sinistre en contentieux : {CLAIM_FR[cl['type']]} de {fr_amount(cl['amount'])} "
                                 f"({cl['claimId']})",
                        "stepId": "openItems"})
    if llm and llm["data-quality"]["status"] != "VALID":
        reasons.append({"code": "DATA_INCONSISTENT",
                        "label": "Données incohérentes : " + (lambda i: i[0].lower() + i[1:])(llm["data-quality"]["issues"][0].rstrip(".")),
                        "stepId": "dataQuality"})
    return reasons


def escalation_level(reasons):
    codes = [r["code"] for r in reasons]
    reinforced = len(reasons) >= 2 or "COLLECTIVE_PROCEDURE" in codes or "UNKNOWN_CUSTOMER" in codes
    return "REINFORCED" if reinforced else "STANDARD"


def script_data(siren):
    """Everything the Groovy mock needs to tell the story of one SIREN."""
    c = COMPANIES.get(siren)
    known = c is not None
    executed = ["checkAccount"]
    if known:
        executed += ["companyIdentity", "legalEvents", "financials", "openItems"]
        executed += ["dataQuality", "climateRisk", "financialHealth", "openItemsReview"] if c["llm"] else []
        executed += ["synthesis"]
    steps = {}
    for sid in executed:
        summary, result, calls = done_step(siren, sid)
        steps[sid] = {"summary": summary, "result": result, "calls": calls}
    return {"known": known, "collective": bool(known and not c["llm"]),
            "name": c["name"] if known else None,
            "declaredHeadcount": c["customer"]["declaredHeadcount"] if known else None,
            "steps": steps, "recommendation": recommendation(siren), "reasons": risk_reasons(siren)}


def groovy_literal(data):
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    assert "\\" not in text and "'''" not in text, "the data must fit in a Groovy ''' string"
    assert len(text.encode("utf-8")) < 60000, "a Groovy string constant is limited to 64 KB"
    return "'''" + text + "'''"


STATE_TTL_SECONDS = 7200


def groovy_prelude():
    """The shared Groovy code: data, timeline and Case builder. Each dispatcher appends its own ending."""
    meta = [{"id": s[0], "label": s[1], "phase": s[2], "mode": s[3], "kind": s[4], "dependsOn": s[5]}
            for s in STEPS]
    cases = "\n".join(f"      case \"{s}\": return slurper.parseText({groovy_literal(script_data(s))})"
                      for s in COMPANIES)
    unknown = groovy_literal(script_data(UNKNOWN_SIREN))
    return f"""import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import java.time.Instant

// Generated by scripts/generate-contracts.py. The mock tells the story of a case from the time elapsed since its
// POST, with durations drawn at random in the ranges of the orchestrator, and waits for the advisor twice.
def slurper = new JsonSlurper()
def json = new groovy.json.JsonGenerator.Options().disableUnicodeEscaping().build()
long now = System.currentTimeMillis()
def META = slurper.parseText({groovy_literal(meta)})
def DECISION_FR = slurper.parseText({groovy_literal(DECISION_FR)})
def dataOf = {{ String siren ->
   switch (siren) {{
{cases}
      default: return slurper.parseText({unknown}.replace("{UNKNOWN_SIREN}", siren))
   }}
}}
def iso = {{ long ms -> Instant.ofEpochMilli(ms).toString() }}
def num = {{ v -> v == null ? null : new BigDecimal(v.toString()) }}
def saveState = {{ st -> store.put("case-" + st.siren, json.toJson(st), {STATE_TTL_SECONDS}) }}
def newState = {{ String siren ->
   def rnd = new Random()
   def draw = {{ int delay, int percent -> int spread = (delay * percent).intdiv(100); delay - spread + rnd.nextInt(2 * spread + 1) }}
   def service = {{ -> draw({SERVICE_DELAY["delay"]}, {SERVICE_SPREAD}) }}
   def bodacc = {{ -> draw({BODACC_DELAY["delay"]}, {BODACC_SPREAD}) }}
   def financials = {{ -> draw({FINANCIALS_DELAY["delay"]}, {FINANCIALS_SPREAD}) }}
   def llm = {{ -> draw({LLM_DELAY["delay"]}, {LLM_SPREAD}) }}
   def financialHealth = {{ -> draw({FINANCIAL_HEALTH_HEADER_DELAY["delay"]}, {FINANCIAL_HEALTH_SPREAD}) }}
   def jitter = [:]
   META.each {{ m -> jitter[m.id] = {JITTER_MIN} + rnd.nextInt({JITTER_MAX - JITTER_MIN + 1}) }}
   [siren: siren, start: now,
    d: [checkAccount: service(), companyIdentity: service(), legalEvents: bodacc(), financials: financials(),
        openItems: service(), dataQuality: llm(), climateRisk: llm() + service() + llm(), financialHealth: financialHealth(),
        openItemsReview: llm(), synthesis: llm(), synthesisRule: 500 + rnd.nextInt(701)],
    j: jitter, review: null, decision: null]
}}
def loadState = {{ String caseId ->
   def m = caseId =~ /^case-([0-9]{{9}})$/
   if (!m.matches()) return null
   def raw = store.get(caseId)
   return raw == null ? null : slurper.parseText(raw)
}}
def buildCase = {{ st ->
   def data = dataOf(st.siren as String)
   def d = st.d
   def j = st.j
   long t0 = st.start as long
   Long reviewAt = st.review ? (st.review.at as long) : null
   Long decidedAt = st.decision ? (st.decision.at as long) : null
   def collection = ["companyIdentity", "legalEvents", "financials", "openItems"]
   def llmPriority = ["dataQuality", "climateRisk", "financialHealth", "openItemsReview", "synthesis"]
   def depsOf = [:]
   META.each {{ m -> depsOf[m.id] = m.dependsOn }}
   def tl = [:]
   def skipReason = [:]
   // A ready step waits for its start jitter (PENDING), then, for an LLM, for a free slot (QUEUED), then runs.
   def run = {{ String id, long ready -> long w = ready + (j[id] as long); tl[id] = [type: "run", want: w, start: w, end: w + (d[id] as long)] }}
   def endOf = {{ ids -> ids.collect {{ def t = tl[it]; (t.type == "skip" ? t.at : t.end) as long }}.max() }}
   def skip = {{ String id, long at, String reason -> tl[id] = [type: "skip", at: at]; skipReason[id] = reason }}
   run("checkAccount", t0)
   long e1 = tl.checkAccount.end as long
   if (!data.known) {{
      META.each {{ m -> if (m.id != "checkAccount" && m.id != "advisorDecision") skip(m.id, e1, "Non exécutée : compte client introuvable.") }}
      tl.advisorDecision = [type: "human", start: e1, doneAt: decidedAt]
   }} else {{
      ["companyIdentity", "legalEvents", "financials", "openItems"].each {{ run(it, e1) }}
      if (data.collective) {{
         // The collective procedure is known when BODACC answers: no LLM is called at all.
         long legal = tl.legalEvents.end as long
         ["dataQuality", "climateRisk", "openItemsReview"].each {{ skip(it, legal, "Non exécutée : procédure collective au BODACC, aucun LLM appelé.") }}
         tl.dataReview = [type: "human", start: endOf(collection + ["dataQuality"]), doneAt: reviewAt]
         if (reviewAt == null) {{
            ["financialHealth", "synthesis", "advisorDecision"].each {{ tl[it] = [type: "notReady"] }}
         }} else {{
            skip("financialHealth", reviewAt, "Non exécutée : procédure collective, aucun LLM appelé.")
            long w = reviewAt + (j.synthesis as long)
            tl.synthesis = [type: "run", want: w, start: w, end: w + (d.synthesisRule as long)]
            tl.advisorDecision = [type: "human", start: tl.synthesis.end, doneAt: decidedAt]
         }}
      }} else {{
         // {LLM_SLOTS} LLM slots shared by every LLM step; among the ready ones, the priority order decides.
         def readyAt = {{ String id ->
            def ends = depsOf[id].collect {{ dep ->
               if (dep == "dataReview") return reviewAt
               def t = tl[dep]
               return t == null ? null : ((t.type == "skip" ? t.at : t.end) as Long)
            }}
            return ends.contains(null) ? null : (ends.max() as long)
         }}
         def slots = {[0] * LLM_SLOTS}.collect {{ 0L }}
         def waiting = llmPriority.collect {{ it }}
         while (true) {{
            def want = [:]
            waiting.each {{ id -> def r = readyAt(id); if (r != null) want[id] = r + (j[id] as long) }}
            if (want.isEmpty()) break
            long free = slots.min() as long
            long t = Math.max(free, want.values().min() as long)
            def pick = want.keySet().findAll {{ (want[it] as long) <= t }}.min {{ llmPriority.indexOf(it) }}
            tl[pick] = [type: "run", want: want[pick], start: t, end: t + (d[pick] as long)]
            slots[slots.indexOf(free)] = t + (d[pick] as long)
            waiting.remove(pick)
         }}
         waiting.each {{ tl[it] = [type: "notReady"] }}
         tl.dataReview = [type: "human", start: endOf(collection + ["dataQuality"]), doneAt: reviewAt]
         tl.advisorDecision = tl.synthesis.type == "run" ?
               [type: "human", start: tl.synthesis.end, doneAt: decidedAt] : [type: "notReady"]
      }}
   }}
   // Something still advances without the advisor: a step waiting for its start, its slot or its answer.
   def advancing = tl.values().any {{ t -> (t.type == "run" && (t.end as long) > now) || (t.type == "skip" && (t.at as long) > now) }}

   def corrections = st.review?.corrections ?: [:]
   def reasons = data.reasons.collect {{ it }}
   if (corrections.declaredHeadcount != null && !reasons.any {{ it.code == "DATA_INCONSISTENT" }}) {{
      reasons << [code: "DATA_INCONSISTENT", label: "Effectif déclaré corrigé par le conseiller : " +
            data.declaredHeadcount + " → " + corrections.declaredHeadcount, stepId: "dataQuality"]
   }}
   def codes = reasons.collect {{ it.code }}
   def level = (reasons.size() >= 2 || codes.contains("COLLECTIVE_PROCEDURE") || codes.contains("UNKNOWN_CUSTOMER")) ?
         "REINFORCED" : "STANDARD"

   def dataReview = st.review == null ? null : [confirmed: st.review.confirmed, corrections: corrections,
         comment: st.review.comment, reviewedAt: iso(reviewAt)]
   def advisorDecision = st.decision == null ? null : [finalDecision: st.decision.finalDecision,
         surchargePercent: num(st.decision.surchargePercent), followsRecommendation: st.decision.followsRecommendation,
         comment: st.decision.comment, acknowledgedReasons: st.decision.acknowledgedReasons, decidedAt: iso(decidedAt)]

   def steps = [:]
   META.each {{ m ->
      def t = tl[m.id]
      def kind = (m.id == "synthesis" && (!data.known || data.collective)) ? "RULE" : m.kind
      def s = [label: m.label, phase: m.phase, mode: m.mode, kind: kind, status: "PENDING", dependsOn: m.dependsOn]
      if (t.type == "skip") {{
         if (now >= (t.at as long)) {{
            s.status = "SKIPPED"; s.summary = skipReason[m.id]
         }}
      }} else if (t.type == "human") {{
         long hs = t.start as long
         if (now >= hs && t.doneAt != null) {{
            s.status = "DONE"; s.startedAt = iso(hs); s.endedAt = iso(t.doneAt as long)
            if (m.id == "dataReview") {{
               s.summary = "Données validées par le conseiller" + (corrections.declaredHeadcount != null ?
                     " (effectif déclaré corrigé : " + data.declaredHeadcount + " → " + corrections.declaredHeadcount + ")" : "") + "."
               s.result = dataReview
            }} else {{
               def sp = num(st.decision.surchargePercent)
               s.summary = "Décision du conseiller : " + DECISION_FR[st.decision.finalDecision] +
                     (sp != null && sp.signum() > 0 ? " de " + sp.stripTrailingZeros().toPlainString() + " %" : "") +
                     (st.decision.followsRecommendation ? " (suggestion suivie)." : " (suggestion écartée).")
               s.result = advisorDecision
            }}
         }} else if (now >= hs) {{
            s.status = "WAITING"; s.startedAt = iso(hs)
            if (m.id == "dataReview") {{
               s.summary = "En attente du conseiller : validation des données collectées."
            }} else if (level == "REINFORCED") {{
               s.summary = "En attente du conseiller : décision renforcée, risque trop important pour " +
                     reasons.size() + " raison" + (reasons.size() > 1 ? "s" : "") + "."
            }} else {{
               s.summary = "En attente du conseiller : décision finale."
            }}
         }}
      }} else if (t.type == "run" && now >= (t.want as long)) {{
         if (now < (t.start as long)) {{
            s.status = "QUEUED"; s.summary = "Prête, en attente d'un créneau LLM."
         }} else if (now < (t.end as long)) {{
            s.status = "RUNNING"; s.startedAt = iso(t.start as long)
         }} else {{
            def done = data.steps[m.id]
            s.status = "DONE"; s.startedAt = iso(t.start as long); s.endedAt = iso(t.end as long)
            s.summary = done.summary; s.result = done.result
            s.calls = done.calls
         }}
      }}
      if (s.calls == null) s.calls = []
      steps[m.id] = s
   }}

   def adv = steps.advisorDecision.status
   def pending = adv == "WAITING" ? "DECISION" : (steps.dataReview.status == "WAITING" ? "DATA_REVIEW" : null)
   def status = adv == "DONE" ? "DECIDED" : (pending != null && !advancing ? "WAITING_ADVISOR" : "IN_PROGRESS")
   def c = [caseId: "case-" + st.siren, siren: st.siren, product: "MULTIRISQUE_PRO"]
   if (data.name) c.companyName = data.name
   c.createdAt = iso(t0)
   c.status = status
   c.pendingAction = pending
   c.stepOrder = META.collect {{ it.id }}
   c.steps = steps
   if (adv == "WAITING" || adv == "DONE") c.recommendation = data.recommendation
   if (dataReview != null) c.dataReview = dataReview
   if (adv == "WAITING" || adv == "DONE") c.escalation = [level: level, reasons: reasons]
   if (advisorDecision != null) c.advisorDecision = advisorDecision
   return c
}}
def respond = {{ st ->
   requestContext.caseJson = json.toJson(buildCase(st))
   return "case"
}}
"""


GROOVY_CREATE = """
def body = slurper.parseText(mockRequest.getRequestContent() ?: "{}")
def siren = body?.siren?.toString()
if (siren == null || !(siren ==~ /[0-9]{9}/)) {
   return "invalid-siren"
}
// A new case always starts over, with new random durations.
saveState(newState(siren))
requestContext.caseId = "case-" + siren
return "created"
"""

GROOVY_GET = """
def st = loadState(mockRequest.getURIParameters().get("caseId"))
if (st == null) {
   return "not-found"
}
return respond(st)
"""

GROOVY_DATA_REVIEW = """
def st = loadState(mockRequest.getURIParameters().get("caseId"))
if (st == null) {
   return "not-found"
}
if (buildCase(st).pendingAction != "DATA_REVIEW") {
   return "not-expected"
}
def body = slurper.parseText(mockRequest.getRequestContent() ?: "{}")
def corrections = [:]
if (body?.corrections?.declaredHeadcount != null) {
   corrections.declaredHeadcount = body.corrections.declaredHeadcount as int
}
st.review = [at: now, confirmed: body?.confirmed != false, corrections: corrections, comment: (body?.comment ?: "").toString()]
saveState(st)
return respond(st)
"""

GROOVY_DECISION = """
def st = loadState(mockRequest.getURIParameters().get("caseId"))
if (st == null) {
   return "not-found"
}
def current = buildCase(st)
if (current.pendingAction != "DECISION") {
   return "not-expected"
}
def body = slurper.parseText(mockRequest.getRequestContent() ?: "{}")
def finalDecision = body?.finalDecision?.toString()
if (!["ACCEPT", "ACCEPT_WITH_SURCHARGE", "REVIEW", "REFUSE", "NOT_ELIGIBLE"].contains(finalDecision)) {
   return "invalid-decision"
}
def reco = current.recommendation
def suggested = num(reco.surchargePercent)
def surcharge = body?.surchargePercent != null ? num(body.surchargePercent) :
      (finalDecision == reco.decision ? suggested : BigDecimal.ZERO)
def follows = finalDecision == reco.decision && surcharge.compareTo(suggested) == 0
def comment = (body?.comment ?: "").toString().trim()
def acknowledged = (body?.acknowledgedReasons ?: []).collect { it.toString() }
if (current.escalation.level == "REINFORCED") {
   if (!acknowledged.containsAll(current.escalation.reasons.collect { it.code })) {
      return "reasons-not-acknowledged"
   }
   if (!comment) {
      return "comment-required"
   }
}
if (!follows && !comment) {
   return "comment-required"
}
st.decision = [at: now, finalDecision: finalDecision, surchargePercent: surcharge, followsRecommendation: follows,
      comment: comment, acknowledgedReasons: acknowledged]
saveState(st)
return respond(st)
"""


def underwriting_cases():
    prelude = groovy_prelude()
    live = {"case": "{{ caseJson }}"}
    errors = {
        "not-found": {"code": "CASE_NOT_FOUND", "message": "Aucun dossier pour cet identifiant."},
        "not-expected": {"code": "NOT_EXPECTED",
                         "message": "Le dossier n'attend pas cette action du conseiller (voir pendingAction)."},
        "comment-required": {"code": "COMMENT_REQUIRED",
                             "message": "Un commentaire est obligatoire pour s'écarter de la suggestion ou pour une "
                                        "décision renforcée."},
        "reasons-not-acknowledged": {"code": "REASONS_NOT_ACKNOWLEDGED",
                                     "message": "Décision renforcée : chaque raison de risque doit être reconnue."},
        "invalid-decision": {"code": "INVALID_DECISION", "message": "finalDecision n'est pas une décision connue."},
        "invalid-siren": {"code": "INVALID_SIREN", "message": "Le SIREN doit compter 9 chiffres."},
    }
    pick = lambda *names: {n: errors[n] for n in names}
    case_param = lambda: [param("caseId", "path", {"case": "case-100000001", "not-found": "case-000000000",
                                                   "not-expected": "case-100000001"})]
    decision = {"type": "string", "enum": ["ACCEPT", "ACCEPT_WITH_SURCHARGE", "REVIEW", "REFUSE", "NOT_ELIGIBLE"]}
    reason_code = {"type": "string", "enum": REASON_ORDER}
    ref = lambda n: {"$ref": "#/components/schemas/" + n}
    nullable = lambda s: {**s, "nullable": True}
    op = lambda script: {"dispatcher": "SCRIPT", "dispatcherRules": prelude + script}
    return openapi(
        "Underwriting cases",
        "L'orchestrateur de souscription Multirisque Pro. Il ouvre un dossier pour un SIREN, collecte les données "
        "(services), attend que le conseiller les valide, fait travailler les analyses LLM (l'agent climat appelle "
        "l'outil Géorisques exposé en MCP par reShapr), propose une suggestion consultative et attend la décision du "
        "conseiller.\n\nLe mock Microcks se comporte comme "
        "l'orchestrateur au temps près : le POST tire au hasard la durée de chaque étape (services 1,2 à 10,8 s, "
        "BODACC 10 à 30 s, comptes annuels 30 à 60 s, LLM 6 à 18 s, agent financial-health 40 à 60 s) et son décalage de démarrage (0,3 à 5 s), et les garde "
        "dans le store ; chaque GET calcule le dossier d'après le temps écoulé, en suivant dependsOn et 2 créneaux "
        "LLM (une étape LLM prête au-delà passe QUEUED). Seule l'analyse financialHealth attend la validation des "
        "données ; pendingAction signale l'action du conseiller dès qu'elle est possible, et status ne passe à "
        "WAITING_ADVISOR que quand plus rien n'avance sans lui. Les réponses sont rendues par templating "
        "(variable caseJson posée par le script).",
        {"/underwriting-cases": {"post": {
            "operationId": "createUnderwritingCase",
            "summary": "Ouvrir un dossier de souscription",
            "x-microcks-operation": op(GROOVY_CREATE),
            "requestBody": {"required": True, "content": json_content("CaseRequest", {
                "created": {"siren": "100000001", "product": "MULTIRISQUE_PRO"},
                "invalid-siren": {"siren": "1234", "product": "MULTIRISQUE_PRO"}})},
            "responses": {
                "202": {"description": "Le dossier est ouvert et la collecte a commencé",
                        "content": json_content("CaseCreated", {"created": {"caseId": "{{ caseId }}",
                                                                            "status": "IN_PROGRESS"}})},
                "400": {"description": "SIREN invalide", "content": json_content("Error", pick("invalid-siren"))}}}},
         "/underwriting-cases/{caseId}": {"get": {
             "operationId": "getUnderwritingCase",
             "summary": "Lire un dossier de souscription",
             "parameters": [param("caseId", "path", {"case": "case-100000001", "not-found": "case-000000000"})],
             "x-microcks-operation": op(GROOVY_GET),
             "responses": {"200": {"description": "Le dossier", "content": json_content("Case", live)},
                           "404": {"description": "Dossier inconnu",
                                   "content": json_content("Error", pick("not-found"))}}}},
         "/underwriting-cases/{caseId}/data-review": {"post": {
             "operationId": "reviewCaseData",
             "summary": "Valider (ou corriger) les données collectées",
             "parameters": case_param(),
             "x-microcks-operation": op(GROOVY_DATA_REVIEW),
             "requestBody": {"required": True, "content": json_content("DataReviewRequest", {
                 "case": {"confirmed": True, "corrections": {"declaredHeadcount": 8},
                          "comment": "Effectif vérifié sur la DSN : 8 salariés."},
                 "not-found": {"confirmed": True, "corrections": {}, "comment": ""},
                 "not-expected": {"confirmed": True, "corrections": {}, "comment": ""}})},
             "responses": {"200": {"description": "Le dossier, qui reprend ses analyses",
                                   "content": json_content("Case", live)},
                           "404": {"description": "Dossier inconnu",
                                   "content": json_content("Error", pick("not-found"))},
                           "409": {"description": "Le dossier n'attend pas la validation des données",
                                   "content": json_content("Error", pick("not-expected"))}}}},
         "/underwriting-cases/{caseId}/advisor-decision": {"post": {
             "operationId": "recordAdvisorDecision",
             "summary": "Enregistrer la décision du conseiller",
             "description": "followsRecommendation est calculé par le serveur : la décision et la surprime sont celles "
                            "de la suggestion. surchargePercent absent vaut la surprime suggérée si la décision est "
                            "celle de la suggestion, 0 sinon. Le commentaire est obligatoire pour s'écarter de la "
                            "suggestion ; en escalade REINFORCED, chaque raison doit être reconnue "
                            "(acknowledgedReasons) et le commentaire est obligatoire.",
             "parameters": [param("caseId", "path", {"case": "case-100000001", "not-found": "case-000000000",
                                                     "not-expected": "case-100000001",
                                                     "comment-required": "case-100000001",
                                                     "reasons-not-acknowledged": "case-100000004",
                                                     "invalid-decision": "case-100000001"})],
             "x-microcks-operation": op(GROOVY_DECISION),
             "requestBody": {"required": True, "content": json_content("AdvisorDecisionRequest", {
                 "case": {"finalDecision": "ACCEPT", "surchargePercent": 0,
                          "comment": COMPANIES["100000001"]["advisor"]["comment"], "acknowledgedReasons": []},
                 "not-found": {"finalDecision": "ACCEPT", "comment": ""},
                 "not-expected": {"finalDecision": "ACCEPT", "comment": "Trop tôt : données non validées."},
                 "comment-required": {"finalDecision": "REFUSE", "comment": ""},
                 "reasons-not-acknowledged": {"finalDecision": "REFUSE", "comment": "Contentieux en cours.",
                                              "acknowledgedReasons": ["OPEN_LITIGATION"]},
                 "invalid-decision": {"finalDecision": "MAYBE", "comment": ""}})},
             "responses": {"200": {"description": "Le dossier décidé", "content": json_content("Case", live)},
                           "400": {"description": "Décision incomplète",
                                   "content": json_content("Error", pick("comment-required", "reasons-not-acknowledged",
                                                                         "invalid-decision"))},
                           "404": {"description": "Dossier inconnu",
                                   "content": json_content("Error", pick("not-found"))},
                           "409": {"description": "Le dossier n'attend pas la décision",
                                   "content": json_content("Error", pick("not-expected"))}}}}},
        {"CaseRequest": obj({"siren": {"type": "string", "pattern": "^[0-9]{9}$"},
                             "product": {"type": "string", "enum": ["MULTIRISQUE_PRO"]}}),
         "CaseCreated": obj({"caseId": STR, "status": {"type": "string", "enum": ["IN_PROGRESS"]}}),
         "Case": obj({"caseId": STR, "siren": STR, "product": STR, "companyName": STR,
                      "createdAt": {"type": "string", "format": "date-time"},
                      "status": {"type": "string", "enum": ["IN_PROGRESS", "WAITING_ADVISOR", "DECIDED"]},
                      "pendingAction": nullable({"type": "string", "enum": ["DATA_REVIEW", "DECISION", None]}),
                      "stepOrder": {"type": "array", "items": STR, "minItems": len(STEPS), "maxItems": len(STEPS)},
                      "steps": obj({sid: ref("Step") for sid, *_ in STEPS}),
                      "recommendation": ref("Recommendation"),
                      "dataReview": ref("DataReview"),
                      "escalation": ref("Escalation"),
                      "advisorDecision": ref("AdvisorDecision")},
                     ["caseId", "siren", "product", "createdAt", "status", "pendingAction", "stepOrder", "steps"]),
         "Step": obj({"label": STR, "phase": {"type": "integer", "minimum": 1, "maximum": 6},
                      "mode": {"type": "string", "enum": ["CHAIN", "PARALLEL"]},
                      "kind": {"type": "string", "enum": ["SERVICE", "MCP", "LLM", "RULE", "HUMAN"]},
                      "status": {"type": "string",
                                 "enum": ["PENDING", "QUEUED", "RUNNING", "WAITING", "DONE", "SKIPPED",
                                          "FAILED"]},
                      "dependsOn": {"type": "array", "items": STR},
                      "startedAt": {"type": "string", "format": "date-time"},
                      "endedAt": {"type": "string", "format": "date-time"},
                      "summary": STR, "result": {"type": "object"},
                      "calls": {"type": "array", "items": ref("Call")}},
                     ["label", "phase", "mode", "kind", "status", "dependsOn", "calls"]),
         "Call": obj({"method": STR, "url": STR, "status": INT,
                      "via": {"type": "string", "enum": ["REST", "MCP", "LLM"]}}),
         "Recommendation": obj({"decision": decision, "surchargePercent": NUM,
                                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                                "rationale": {"type": "array", "items": STR},
                                "source": {"type": "string", "enum": ["LLM", "RULE"]}}),
         "Corrections": obj({"declaredHeadcount": {"type": "integer", "minimum": 0}}, []),
         "DataReviewRequest": obj({"confirmed": BOOL, "corrections": ref("Corrections"), "comment": STR},
                                  ["confirmed"]),
         "DataReview": obj({"confirmed": BOOL, "corrections": ref("Corrections"), "comment": STR,
                            "reviewedAt": {"type": "string", "format": "date-time"}}),
         "Escalation": obj({"level": {"type": "string", "enum": ["STANDARD", "REINFORCED"]},
                            "reasons": {"type": "array", "items": ref("RiskReason")}}),
         "RiskReason": obj({"code": reason_code, "label": STR, "stepId": STR}),
         "AdvisorDecisionRequest": obj({"finalDecision": decision, "surchargePercent": NUM, "comment": STR,
                                        "acknowledgedReasons": {"type": "array", "items": reason_code}},
                                       ["finalDecision"]),
         "AdvisorDecision": obj({"finalDecision": decision, "surchargePercent": NUM, "followsRecommendation": BOOL,
                                 "comment": STR, "acknowledgedReasons": {"type": "array", "items": reason_code},
                                 "decidedAt": {"type": "string", "format": "date-time"}},
                                ["finalDecision", "surchargePercent", "followsRecommendation", "comment",
                                 "decidedAt"]),
         "Error": error_schema()})


# --------------------------------------------------------------------------------------------------------------
# Arazzo workflows and their overlay
# --------------------------------------------------------------------------------------------------------------

# The document has several sources: every operationId is qualified with its source.
UNDERWRITING_API = "$sourceDescriptions.underwritingApi."


def body_is(pointer, value):
    rendered = repr(value) if isinstance(value, str) else json.dumps(value)
    return {"condition": f"$response.body#{pointer} == {rendered}"}


def status_is(code):
    return {"condition": f"$statusCode == {code}"}


SIREN_INPUT = {"siren": {"type": "string", "pattern": "^[0-9]{9}$"}}
PHASE2 = ["companyIdentity", "legalEvents", "financials", "openItems"]
ANALYSES = ["climateRisk", "financialHealth", "openItemsReview"]
CASE_ID = "$steps.openCase.outputs.caseId"


def inputs(props, required=None):
    return {"type": "object", "properties": props, "required": required or list(props)}


def open_case():
    return {"stepId": "openCase", "operationId": UNDERWRITING_API + "createUnderwritingCase",
            "requestBody": {"contentType": "application/json",
                            "payload": {"siren": "", "product": "MULTIRISQUE_PRO"},
                            "replacements": [{"target": "/siren", "value": "$inputs.siren"}]},
            "successCriteria": [status_is(202), body_is("/status", "IN_PROGRESS")],
            "outputs": {"caseId": "$response.body#/caseId"}}


def wait_for(step_id, pending, checks, outputs=None, description=None):
    s = {"stepId": step_id, "operationId": UNDERWRITING_API + "getUnderwritingCase",
         "description": description or f"Lit le dossier toutes les 2 s (150 fois au plus) jusqu'à ce que "
                                       f"pendingAction soit {pending}.",
         "parameters": [{"name": "caseId", "in": "path", "value": CASE_ID}],
         "successCriteria": [status_is(200), body_is("/pendingAction", pending)] + checks,
         "onFailure": [{"name": "advisorNotExpectedYet", "type": "retry", "retryAfter": 2, "retryLimit": 150,
                        "criteria": [{"condition": f"$response.body#/pendingAction != '{pending}'"}]}]}
    if outputs:
        s["outputs"] = outputs
    return s


def read_case(step_id, checks, description):
    return {"stepId": step_id, "operationId": UNDERWRITING_API + "getUnderwritingCase", "description": description,
            "parameters": [{"name": "caseId", "in": "path", "value": CASE_ID}],
            "successCriteria": [status_is(200)] + checks}


def review_data(step_id="validateData"):
    return {"stepId": step_id, "operationId": UNDERWRITING_API + "reviewCaseData",
            "description": "Le conseiller confirme les données collectées.",
            "parameters": [{"name": "caseId", "in": "path", "value": CASE_ID}],
            "requestBody": {"contentType": "application/json",
                            "payload": {"confirmed": True, "corrections": {},
                                        "comment": "Données vérifiées par le conseiller."}},
            "successCriteria": [status_is(200), body_is("/status", "IN_PROGRESS"),
                                body_is("/steps/dataReview/status", "DONE"), body_is("/dataReview/confirmed", True)]}


def decide(step_id, payload, replacements, checks, outputs=None, description=None):
    s = {"stepId": step_id, "operationId": UNDERWRITING_API + "recordAdvisorDecision"}
    if description:
        s["description"] = description
    s["parameters"] = [{"name": "caseId", "in": "path", "value": CASE_ID}]
    s["requestBody"] = {"contentType": "application/json", "payload": payload}
    if replacements:
        s["requestBody"]["replacements"] = [{"target": t, "value": v} for t, v in replacements.items()]
    s["successCriteria"] = checks
    if outputs:
        s["outputs"] = outputs
    return s


def decided_checks(follows):
    return [status_is(200), body_is("/status", "DECIDED"), body_is("/steps/advisorDecision/status", "DONE"),
            body_is("/advisorDecision/followsRecommendation", follows)]


DECISION_OUTPUTS = {"status": "$response.body#/status", "finalDecision": "$response.body#/advisorDecision/finalDecision",
                    "followsRecommendation": "$response.body#/advisorDecision/followsRecommendation"}
SUGGESTION_OUTPUTS = {"suggestedDecision": "$response.body#/recommendation/decision",
                      "suggestedSurchargePercent": "$response.body#/recommendation/surchargePercent",
                      "escalationLevel": "$response.body#/escalation/level"}


def data_review_checks(collective=False):
    """At DATA_REVIEW: the collection is done (data quality checked, or skipped by rule), and financialHealth has not
    started without the advisor (climateRisk and openItemsReview may already run)."""
    return ([body_is(f"/steps/{s}/status", "DONE") for s in ["checkAccount"] + PHASE2]
            + [body_is("/steps/dataQuality/status", "SKIPPED" if collective else "DONE"),
               body_is("/steps/dataReview/status", "WAITING")]
            + [body_is(f"/steps/{s}/status", "PENDING") for s in ["financialHealth", "synthesis", "advisorDecision"]])


def llm_suggestion_checks():
    return ([body_is("/status", "WAITING_ADVISOR")] + [body_is(f"/steps/{s}/status", "DONE") for s in ANALYSES + ["synthesis"]]
            + [body_is(f"/steps/climateRisk/calls/{i}/via", via) for i, via in enumerate(["MCP", "LLM", "MCP", "LLM"])]
            + [body_is("/steps/synthesis/kind", "LLM"), body_is("/recommendation/source", "LLM"),
               body_is("/steps/advisorDecision/status", "WAITING")])


def wf_outputs(mapping):
    return {name: f"$steps.{step}.outputs.{out}" for name, (step, out) in mapping.items()}


def arazzo():
    suggestion = {k: ("waitForSuggestion", k) for k in SUGGESTION_OUTPUTS}
    decided = {k: ("decide", k) for k in DECISION_OUTPUTS}
    workflows = [
        {"workflowId": "advisorValidatesThenDecides",
         "summary": "Le conseiller valide les données, puis suit la suggestion des analyses (escalade standard).",
         "inputs": inputs(SIREN_INPUT),
         "steps": [open_case(),
                   wait_for("waitForDataReview", "DATA_REVIEW", data_review_checks()),
                   review_data(),
                   wait_for("waitForSuggestion", "DECISION",
                            llm_suggestion_checks() + [body_is("/escalation/level", "STANDARD")], SUGGESTION_OUTPUTS),
                   decide("decide", {"finalDecision": "REVIEW", "surchargePercent": 0,
                                     "comment": "Je suis la suggestion des analyses.", "acknowledgedReasons": []},
                          {"/finalDecision": "$steps.waitForSuggestion.outputs.suggestedDecision",
                           "/surchargePercent": "$steps.waitForSuggestion.outputs.suggestedSurchargePercent"},
                          decided_checks(True), DECISION_OUTPUTS)],
         "outputs": wf_outputs({**suggestion, **decided})},
        {"workflowId": "advisorOverridesSuggestion",
         "summary": "Le conseiller ne suit pas la suggestion : son commentaire est enregistré et "
                    "followsRecommendation vaut false.",
         "inputs": inputs({**SIREN_INPUT, "finalDecision": {"type": "string"}, "surchargePercent": {"type": "number"},
                           "comment": {"type": "string", "minLength": 1}}),
         "steps": [open_case(),
                   wait_for("waitForDataReview", "DATA_REVIEW", data_review_checks()),
                   review_data(),
                   wait_for("waitForSuggestion", "DECISION", llm_suggestion_checks(), SUGGESTION_OUTPUTS),
                   decide("decide", {"finalDecision": "REVIEW", "surchargePercent": 0, "comment": "",
                                     "acknowledgedReasons": []},
                          {"/finalDecision": "$inputs.finalDecision", "/surchargePercent": "$inputs.surchargePercent",
                           "/comment": "$inputs.comment"},
                          decided_checks(False), DECISION_OUTPUTS)],
         "outputs": wf_outputs({**suggestion, **decided})},
        {"workflowId": "decisionWithoutCommentIsRefused",
         "summary": "S'écarter de la suggestion sans commentaire est refusé (400), et le dossier attend toujours.",
         "inputs": inputs({**SIREN_INPUT, "finalDecision": {"type": "string"}}),
         "steps": [open_case(),
                   wait_for("waitForDataReview", "DATA_REVIEW", data_review_checks()),
                   review_data(),
                   wait_for("waitForSuggestion", "DECISION", llm_suggestion_checks(), SUGGESTION_OUTPUTS),
                   decide("decideWithoutComment", {"finalDecision": "REFUSE", "surchargePercent": 0, "comment": "",
                                                   "acknowledgedReasons": []},
                          {"/finalDecision": "$inputs.finalDecision"},
                          [status_is(400), body_is("/code", "COMMENT_REQUIRED")],
                          {"errorCode": "$response.body#/code"}),
                   read_case("stillWaiting", [body_is("/status", "WAITING_ADVISOR"),
                                              body_is("/pendingAction", "DECISION")],
                             "Le refus n'a rien enregistré : le dossier attend toujours la décision.")],
         "outputs": wf_outputs({"suggestedDecision": ("waitForSuggestion", "suggestedDecision"),
                                "errorCode": ("decideWithoutComment", "errorCode")})},
        {"workflowId": "noDecisionBeforeDataReview",
         "summary": "Décider avant d'avoir validé les données est refusé (409) : l'orchestrateur attend la "
                    "validation.",
         "inputs": inputs(SIREN_INPUT),
         "steps": [open_case(),
                   wait_for("waitForDataReview", "DATA_REVIEW", data_review_checks()),
                   decide("decideTooEarly", {"finalDecision": "ACCEPT", "surchargePercent": 0,
                                             "comment": "Trop tôt : données non validées.", "acknowledgedReasons": []},
                          {}, [status_is(409), body_is("/code", "NOT_EXPECTED")],
                          {"errorCode": "$response.body#/code"}),
                   read_case("stillWaitingForDataReview", [body_is("/pendingAction", "DATA_REVIEW")],
                             "Le dossier attend toujours la validation des données.")],
         "outputs": wf_outputs({"errorCode": ("decideTooEarly", "errorCode")})},
        {"workflowId": "unknownCustomerNeedsNoAnalysis",
         "summary": "Sans compte client, rien n'est analysé : la règle suggère NOT_ELIGIBLE et le conseiller "
                    "confirme, en décision renforcée.",
         "inputs": inputs(SIREN_INPUT),
         "steps": [open_case(),
                   wait_for("waitForDecision", "DECISION",
                            [body_is("/status", "WAITING_ADVISOR"), body_is("/steps/checkAccount/status", "DONE"),
                             body_is("/steps/checkAccount/calls/0/status", 404)]
                            + [body_is(f"/steps/{s}/status", "SKIPPED")
                               for s in PHASE2 + ["dataQuality", "dataReview"] + ANALYSES + ["synthesis"]]
                            + [body_is("/recommendation/decision", "NOT_ELIGIBLE"),
                               body_is("/recommendation/source", "RULE"), body_is("/escalation/level", "REINFORCED"),
                               body_is("/escalation/reasons/0/code", "UNKNOWN_CUSTOMER")],
                            SUGGESTION_OUTPUTS),
                   decide("decide", {"finalDecision": "NOT_ELIGIBLE", "comment": "Prospect inconnu du CRM : "
                                                                                 "à créer avant toute étude.",
                                     "acknowledgedReasons": ["UNKNOWN_CUSTOMER"]},
                          {}, decided_checks(True), DECISION_OUTPUTS)],
         "outputs": wf_outputs({**{k: ("waitForDecision", k) for k in SUGGESTION_OUTPUTS}, **decided})},
        {"workflowId": "highRiskRequiresReinforcedDecision",
         "summary": "Un risque trop important pour plusieurs raisons exige une décision renforcée : sans "
                    "reconnaître chaque raison, la décision est refusée (400).",
         "inputs": inputs({**SIREN_INPUT, "finalDecision": {"type": "string"},
                           "comment": {"type": "string", "minLength": 1},
                           "acknowledgedReasons": {"type": "array", "items": {"type": "string"}}}),
         "steps": [open_case(),
                   wait_for("waitForDataReview", "DATA_REVIEW", data_review_checks()),
                   review_data(),
                   wait_for("waitForSuggestion", "DECISION",
                            llm_suggestion_checks() + [body_is("/escalation/level", "REINFORCED")], SUGGESTION_OUTPUTS),
                   decide("decideWithoutAcknowledging", {"finalDecision": "REFUSE", "comment": "",
                                                         "acknowledgedReasons": []},
                          {"/finalDecision": "$inputs.finalDecision", "/comment": "$inputs.comment"},
                          [status_is(400), body_is("/code", "REASONS_NOT_ACKNOWLEDGED")],
                          {"errorCode": "$response.body#/code"}),
                   decide("decide", {"finalDecision": "REFUSE", "comment": "", "acknowledgedReasons": []},
                          {"/finalDecision": "$inputs.finalDecision", "/comment": "$inputs.comment",
                           "/acknowledgedReasons": "$inputs.acknowledgedReasons"},
                          [status_is(200), body_is("/status", "DECIDED"),
                           body_is("/steps/advisorDecision/status", "DONE")], DECISION_OUTPUTS)],
         "outputs": wf_outputs({**suggestion, "rejectedWith": ("decideWithoutAcknowledging", "errorCode"),
                                **decided})},
        {"workflowId": "collectiveProcedureSkipsAnalyses",
         "summary": "Une procédure collective : le conseiller valide les données, aucune analyse LLM n'est faite, la "
                    "règle suggère REFUSE et le conseiller décide.",
         "inputs": inputs(SIREN_INPUT),
         "steps": [open_case(),
                   wait_for("waitForDataReview", "DATA_REVIEW",
                            data_review_checks(True) + [body_is("/steps/legalEvents/result/records/0/type",
                                                            "PROCEDURE_COLLECTIVE")]),
                   review_data(),
                   wait_for("waitForDecision", "DECISION",
                            [body_is("/status", "WAITING_ADVISOR")]
                            + [body_is(f"/steps/{s}/status", "SKIPPED") for s in ["dataQuality"] + ANALYSES]
                            + [body_is("/steps/synthesis/status", "DONE"), body_is("/steps/synthesis/kind", "RULE"),
                               body_is("/recommendation/decision", "REFUSE"), body_is("/recommendation/source", "RULE"),
                               body_is("/escalation/level", "REINFORCED"),
                               body_is("/escalation/reasons/0/code", "COLLECTIVE_PROCEDURE")],
                            SUGGESTION_OUTPUTS),
                   decide("decide", {"finalDecision": "REFUSE",
                                     "comment": "Redressement judiciaire en cours : refus confirmé.",
                                     "acknowledgedReasons": ["COLLECTIVE_PROCEDURE"]},
                          {}, decided_checks(True), DECISION_OUTPUTS)],
         "outputs": wf_outputs({**{k: ("waitForDecision", k) for k in SUGGESTION_OUTPUTS}, **decided})},
    ]
    return {
        "arazzo": "1.1.0",  # dependsOn on a step needs Arazzo 1.1; the advisor workflows do not use it
        "info": {"title": "Commercial underwriting", "version": "1.0.0",
                 "summary": "Le parcours d'un dossier Multirisque Pro, avec le conseiller au cœur.",
                 "description": "Chaque workflow ouvre un dossier, puis le lit toutes les 2 s jusqu'à ce que l'action "
                                "du conseiller soit attendue (pendingAction). Il joue aussi le rôle du conseiller : il valide les données et prend la "
                                "décision. Arazzo vérifie ainsi que l'orchestrateur s'arrête et attend l'humain aux "
                                "bons endroits, n'appelle aucun LLM quand une règle suffit, et exige une décision "
                                "renforcée quand le risque est trop important. Les workflows tournent contre "
                                "l'orchestrateur .NET comme contre son mock Microcks.\n"},
        # No LLM gateway source here: in a session, every LLM call would be an unexpected call (see the guards).
        "sourceDescriptions": [{"name": "underwritingApi", "url": "./underwriting-cases.openapi.yaml",
                                "type": "openapi"}] + source_descriptions(CONSUMER_SOURCES),
        "workflows": workflows + consumer_workflows()}


# --------------------------------------------------------------------------------------------------------------
# The consumer view: what the orchestrator must call (verified by an Arazzo session, S15 to S17)
# --------------------------------------------------------------------------------------------------------------

CONSUMER_SOURCES = [  # source name, file, Microcks API
    ("customerAccounts", "customer-accounts.openapi.yaml", "Customer accounts"),
    ("sirene", "sirene.openapi.yaml", "Sirene"),
    ("bodacc", "bodacc.openapi.yaml", "BODACC"),
    ("companyFinancials", "company-financials.openapi.yaml", "Company financials"),
    ("claimsAndContracts", "claims-and-contracts.openapi.yaml", "Claims and contracts"),
]
LLM_SOURCE = ("llmGateway", "llm-gateway.openapi.yaml", "LLM gateway")


def source_descriptions(sources):
    return [{"name": n, "url": "./" + f, "type": "openapi"} for n, f, _ in sources]


def overlay_sources(sources):
    return {n: {"name": api, "version": "1.0.0"} for n, _, api in sources}


def check_account_step(expected_status=200):
    s = {"stepId": "checkAccount", "operationId": "$sourceDescriptions.customerAccounts.getCustomerBySiren",
         "parameters": [{"name": "siren", "in": "path", "value": "$inputs.siren"}],
         "successCriteria": [status_is(expected_status)]}
    if expected_status == 200:
        s["outputs"] = {"customerId": "$response.body#/customerId"}
    return s


def collection_steps():
    """checkAccount, then the 4 sources in parallel: dependsOn relaxes the strict order of the list (Arazzo 1.1)."""
    def parallel(step_id, operation, name, where, value, outputs=None):
        s = {"stepId": step_id, "operationId": operation, "dependsOn": ["checkAccount"],
             "parameters": [{"name": name, "in": where, "value": value}],
             "successCriteria": [status_is(200)]}
        if outputs:
            s["outputs"] = outputs
        return s
    return [check_account_step(),
            parallel("companyIdentity", "$sourceDescriptions.sirene.getUniteLegale", "siren", "path", "$inputs.siren",
                     {"inseeCityCode": "$response.body#/address/inseeCityCode"}),
            parallel("legalEvents", "$sourceDescriptions.bodacc.searchAnnonces", "siren", "query", "$inputs.siren"),
            parallel("financials", "$sourceDescriptions.companyFinancials.getFinancials", "siren", "path",
                     "$inputs.siren"),
            # The data flow the verification checks: the claims are read with the customerId the CRM returned.
            parallel("openItems", "$sourceDescriptions.claimsAndContracts.getOpenItems", "customerId", "path",
                     "$steps.checkAccount.outputs.customerId")]


def consumer_workflows():
    return [
        {"workflowId": "orchestratorCollectsCompanyData",
         "summary": "Ce que l'orchestrateur doit appeler pour un dossier : le CRM d'abord, puis les 4 sources en "
                    "parallèle, avec le customerId du CRM pour les sinistres.",
         "inputs": inputs(SIREN_INPUT),
         "steps": collection_steps(),
         "outputs": {"customerId": "$steps.checkAccount.outputs.customerId"}},
        {"workflowId": "customerUnknownStopsTheCase",
         "summary": "Le CRM ne connaît pas le SIREN : l'orchestrateur s'arrête après lui, sans appeler les 4 sources.",
         "inputs": inputs(SIREN_INPUT),
         # In a session, the successCriteria are not evaluated: the 404 is documentary there.
         "steps": [check_account_step(404)]},
    ]


def guards_arazzo():
    return {
        "arazzo": "1.1.0",
        "info": {"title": "Commercial underwriting guards", "version": "1.0.0",
                 "summary": "Ce que l'orchestrateur ne doit PAS appeler.",
                 "description": "Le LLM gateway est lié au document sans aucune étape : dans une session, tout appel "
                                "LLM est un appel inattendu. Avec une procédure collective (injectée par S17 sur "
                                "legalEvents), la collecte se termine et aucun LLM n'est appelé.\n"},
        "sourceDescriptions": source_descriptions(CONSUMER_SOURCES + [LLM_SOURCE]),
        "workflows": [
            {"workflowId": "collectiveProcedureStopsTheAnalyses",
             "summary": "Le BODACC signale une procédure collective : la collecte se termine, et aucun LLM n'est "
                        "appelé.",
             "inputs": inputs(SIREN_INPUT),
             "steps": collection_steps(),
             "outputs": {"customerId": "$steps.checkAccount.outputs.customerId"}}]}


def guards_arazzo_sources():
    s3 = "100000003"
    return {"apiVersion": "mocks.microcks.io/v1alpha1", "kind": "ArazzoSources",
            "metadata": {"name": "Commercial underwriting guards", "version": "1.0.0"},
            "sources": overlay_sources(CONSUMER_SOURCES + [LLM_SOURCE]),
            "examples": {"collectiveProcedureStopsTheAnalyses": {
                "siren-" + s3: {"inputs": {"siren": s3}, "outputs": {"customerId": customer_id(s3)}}}}}


def arazzo_sources():
    def reco(s):
        r = recommendation(s)
        return {"suggestedDecision": r["decision"], "suggestedSurchargePercent": r["surchargePercent"],
                "escalationLevel": escalation_level(risk_reasons(s))}

    def outcome(final, follows):
        return {"status": "DECIDED", "finalDecision": final, "followsRecommendation": follows}

    s1, s2, s3, s4, s9 = "100000001", "100000002", "100000003", "100000004", UNKNOWN_SIREN
    a1, a2, a4 = COMPANIES[s1]["advisor"], COMPANIES[s2]["advisor"], COMPANIES[s4]["advisor"]
    unknown_reco = reco(s9)
    collective_reco = reco(s3)
    return {"apiVersion": "mocks.microcks.io/v1alpha1", "kind": "ArazzoSources",
            "metadata": {"name": "Commercial underwriting", "version": "1.0.0"},
            "sources": {"underwritingApi": {"name": "Underwriting cases", "version": "1.0.0"},
                        **overlay_sources(CONSUMER_SOURCES)},
            "examples": {
                "advisorValidatesThenDecides": {
                    "siren-" + s: {"inputs": {"siren": s},
                                   "outputs": {**reco(s), **outcome(recommendation(s)["decision"], True)}}
                    for s in (s1, s2)},
                "advisorOverridesSuggestion": {
                    "siren-" + s1: {"inputs": {"siren": s1, "finalDecision": a1["finalDecision"], "surchargePercent": 0,
                                               "comment": a1["comment"]},
                                    "outputs": {**reco(s1), **outcome(a1["finalDecision"], False)}},
                    "siren-" + s2: {"inputs": {"siren": s2, "finalDecision": a2["finalDecision"], "surchargePercent": 0,
                                               "comment": a2["comment"]},
                                    "outputs": {**reco(s2), **outcome(a2["finalDecision"], False)}}},
                "decisionWithoutCommentIsRefused": {
                    "siren-" + s2: {"inputs": {"siren": s2, "finalDecision": "REFUSE"},
                                    "outputs": {"suggestedDecision": "ACCEPT", "errorCode": "COMMENT_REQUIRED"}}},
                "noDecisionBeforeDataReview": {
                    "siren-" + s1: {"inputs": {"siren": s1}, "outputs": {"errorCode": "NOT_EXPECTED"}}},
                "unknownCustomerNeedsNoAnalysis": {
                    "siren-" + s9: {"inputs": {"siren": s9},
                                    "outputs": {**unknown_reco, **outcome("NOT_ELIGIBLE", True)}}},
                "highRiskRequiresReinforcedDecision": {
                    "siren-" + s4: {"inputs": {"siren": s4, "finalDecision": a4["finalDecision"],
                                               "comment": a4["comment"],
                                               "acknowledgedReasons": [r["code"] for r in risk_reasons(s4)]},
                                    "outputs": {**reco(s4), "rejectedWith": "REASONS_NOT_ACKNOWLEDGED",
                                                **outcome(a4["finalDecision"], False)}}},
                "collectiveProcedureSkipsAnalyses": {
                    "siren-" + s3: {"inputs": {"siren": s3},
                                    "outputs": {**collective_reco, **outcome("REFUSE", True)}}},
                "orchestratorCollectsCompanyData": {
                    "siren-" + s2: {"inputs": {"siren": s2}, "outputs": {"customerId": customer_id(s2)}}},
                "customerUnknownStopsTheCase": {
                    "siren-" + s9: {"inputs": {"siren": s9}, "steps": {"checkAccount": {"status": 404}}}}}}


HEADER = "Generated by scripts/generate-contracts.py from the table of the five demo companies. Do not edit by hand."

if __name__ == "__main__":
    CONTRACTS.mkdir(exist_ok=True)
    write("customer-accounts.openapi.yaml", customer_accounts(), HEADER)
    write("sirene.openapi.yaml", sirene(), HEADER)
    write("bodacc.openapi.yaml", bodacc(), HEADER)
    write("georisques.openapi.yaml", georisques(), HEADER)
    write("company-financials.openapi.yaml", company_financials(), HEADER)
    write("claims-and-contracts.openapi.yaml", claims_and_contracts(), HEADER)
    write("llm-gateway.openapi.yaml", llm_gateway(), HEADER)
    write("underwriting-cases.openapi.yaml", underwriting_cases(), HEADER)
    write("underwriting.arazzo.yaml", arazzo(), HEADER)
    write("underwriting.arazzo-sources.yaml", arazzo_sources(), HEADER)
    write("underwriting-guards.arazzo.yaml", guards_arazzo(), HEADER)
    write("underwriting-guards.arazzo-sources.yaml", guards_arazzo_sources(), HEADER)
