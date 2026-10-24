using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace UnderwritingOrchestrator.WorkflowTests.Infrastructure;

/// <summary>
/// The Microcks session of the work in progress. Captured at the start of an incoming request, it flows with the
/// ExecutionContext into Task.Run and across awaits: the orchestrator's background case keeps it to the end.
/// </summary>
public static class MicrocksSession
{
    public const string Header = "x-microcks-session";
    public const string BaggageKey = "microcks-session";

    private static readonly AsyncLocal<string?> CurrentSession = new();

    public static string? Current
    {
        get => CurrentSession.Value;
        set => CurrentSession.Value = value;
    }

    /// <summary>The session of a request: header x-microcks-session, else the W3C baggage entry microcks-session.</summary>
    public static string? ReadFrom(IHeaderDictionary headers)
    {
        if (headers.TryGetValue(Header, out var direct) && !string.IsNullOrWhiteSpace(direct))
            return direct.ToString().Trim();
        foreach (var baggage in headers["baggage"])   // "k1=v1,k2=v2;property"
        {
            foreach (var member in (baggage ?? "").Split(','))
            {
                var keyValue = member.Split(';')[0].Split('=', 2);
                if (keyValue.Length == 2 && keyValue[0].Trim() == BaggageKey)
                    return Uri.UnescapeDataString(keyValue[1].Trim());
            }
        }
        return null;
    }
}

/// <summary>First middleware of the pipeline: remembers the session of the incoming request.</summary>
internal sealed class MicrocksSessionStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use(async (context, nextMiddleware) =>
        {
            if (MicrocksSession.ReadFrom(context.Request.Headers) is { } sessionId)
                MicrocksSession.Current = sessionId;
            await nextMiddleware(context);
        });
        next(app);
    };
}

/// <summary>Puts the current session on every outgoing call: REST, MCP and LLM clients alike.</summary>
public sealed class SessionPropagationHandler : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (MicrocksSession.Current is { } sessionId && !request.Headers.Contains(MicrocksSession.Header))
            request.Headers.TryAddWithoutValidation(MicrocksSession.Header, sessionId);
        return base.SendAsync(request, ct);
    }
}

public static class MicrocksSessionServiceCollectionExtensions
{
    public static IServiceCollection AddMicrocksSessionPropagation(this IServiceCollection services)
    {
        services.AddTransient<IStartupFilter, MicrocksSessionStartupFilter>();
        services.AddTransient<SessionPropagationHandler>();
        // .NET 8+: applies to every IHttpClientFactory client, including the typed CompanyDataApis, McpClient and
        // LlmGatewayClient registered by the orchestrator's Program.cs
        services.ConfigureHttpClientDefaults(http => http.AddHttpMessageHandler<SessionPropagationHandler>());
        return services;
    }
}
