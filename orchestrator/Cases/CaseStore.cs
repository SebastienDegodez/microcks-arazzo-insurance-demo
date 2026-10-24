using System.Collections.Concurrent;

namespace UnderwritingOrchestrator.Cases;

/// <summary>
/// In-memory store of underwriting cases, lost on restart. One live case per SIREN, named case-&lt;siren&gt; like in the
/// Microcks mock and in the recorded Arazzo examples: opening a case again replaces the previous one.
/// </summary>
public sealed class CaseStore
{
    private readonly ConcurrentDictionary<string, UnderwritingCase> _cases = new();

    public UnderwritingCase Open(string siren, string product)
    {
        var caseId = $"case-{siren}";
        var underwritingCase = new UnderwritingCase { CaseId = caseId, Siren = siren, Product = product };
        if (_cases.TryGetValue(caseId, out var replaced))
            replaced.DataReviewed.TrySetCanceled(); // its workflow stops waiting for a review that will never come
        _cases[caseId] = underwritingCase;
        return underwritingCase;
    }

    public UnderwritingCase? Find(string caseId) => _cases.GetValueOrDefault(caseId);
}
