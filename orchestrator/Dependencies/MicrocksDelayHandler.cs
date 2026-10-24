using Microsoft.Extensions.Options;

namespace UnderwritingOrchestrator.Dependencies;

/// <summary>
/// Section "Demo:MicrocksDelayOverride" of appsettings.json, empty by default: the mocks then use the latency declared
/// in their contracts. When set, e.g. {"Delay": 4000, "Strategy": "random-50"}, it overrides it on every call.
/// </summary>
public sealed class MicrocksDelayOverride
{
    public int? Delay { get; set; }
    public string? Strategy { get; set; }
}

/// <summary>Adds the x-microcks-delay headers to every outgoing call (REST, MCP, LLM) when an override is configured.</summary>
public sealed class MicrocksDelayHandler(IOptionsMonitor<MicrocksDelayOverride> options) : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (!request.Headers.Contains(DelayHeader)) // a per-agent override, set by the caller, wins
            Apply(request, options.CurrentValue);
        return base.SendAsync(request, ct);
    }

    public const string DelayHeader = "x-microcks-delay";
    public const string DelayStrategyHeader = "x-microcks-delay-strategy";

    public static void Apply(HttpRequestMessage request, MicrocksDelayOverride delayOverride)
    {
        if (delayOverride.Delay is { } delay)
            request.Headers.TryAddWithoutValidation(DelayHeader, delay.ToString());
        if (!string.IsNullOrWhiteSpace(delayOverride.Strategy))
            request.Headers.TryAddWithoutValidation(DelayStrategyHeader, delayOverride.Strategy);
    }
}
