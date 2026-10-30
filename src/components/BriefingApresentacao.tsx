// =============================================================
// BriefingApresentacao — rota publica /?briefing=<id>
// =============================================================
// Pagina client-facing do briefing. Remove secoes sensiveis
// (competitiva, pergunta de impacto, alertas, resumo falado).
// Nao exige login. Carrega via Edge Function prep-call-public.
// Dispara track de view via prep-call-view-track.
// Visual: identidade V4 das paginas EE 2026 (a mesma dos slides do Gerador de
// Propostas): vinho #280000, vermelho #E50914/#FB2E0A, amarelo #FFD60A,
// titulos Anton, texto IBM Plex Sans. Mostra as imagens que o motor capturou
// (site, perfil, Google Ads e criativos da Meta) quando existem.
// =============================================================
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';

interface BriefingPayload {
  id: string;
  empresa: string;
  schema_version: string;
  version: number;
  completed_at: string;
  briefing: any;
}

// 30min sessionStorage — mesmo do debounce server-side
function getOrCreateSessionToken(briefingId: string): string {
  const key = `bv_session_${briefingId}`;
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const token = crypto.randomUUID();
  sessionStorage.setItem(key, token);
  return token;
}

async function trackView(briefingId: string) {
  try {
    const token = getOrCreateSessionToken(briefingId);
    await fetch(`${SUPABASE_URL}/functions/v1/prep-call-view-track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        briefing_id: briefingId,
        session_token: token,
        referrer: document.referrer || null,
      }),
    });
  } catch {
    /* silent — tracking nao bloqueia UX */
  }
}

export const BriefingApresentacao: React.FC<{ briefingId: string }> = ({ briefingId }) => {
  const [payload, setPayload] = useState<BriefingPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string>('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/prep-call-public?id=${briefingId}`);
        const body = await r.json();
        if (!r.ok) {
          setError(body.error || `HTTP ${r.status}`);
        } else {
          setPayload(body);
          // Track view — async, nao bloqueia render
          trackView(briefingId);
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [briefingId]);

  // IntersectionObserver pra destacar secao no indice sticky
  useEffect(() => {
    if (!payload) return;
    const sections = document.querySelectorAll('section[data-sec]');
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActiveSection(e.target.getAttribute('data-sec') || '');
        });
      },
      { rootMargin: '-40% 0px -55% 0px' }
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [payload]);

  if (loading) {
    return (
      <div style={styles.fullScreen}>
        <Loader2 size={40} className="animate-spin" style={{ color: '#E50914' }} />
        <p style={{ color: '#B8A6A3', marginTop: 14, fontSize: 14 }}>Carregando briefing...</p>
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div style={styles.fullScreen}>
        <AlertTriangle size={48} style={{ color: '#E50914' }} />
        <h1 style={{ color: 'white', margin: '16px 0 8px', fontSize: 22 }}>
          Briefing indisponível
        </h1>
        <p style={{ color: '#B8A6A3', textAlign: 'center', maxWidth: 420, lineHeight: 1.5 }}>
          {error === 'briefing legacy (no json available)'
            ? 'Este briefing foi gerado antes da versão apresentável. Peça para o responsável rodar de novo.'
            : error || 'Verifique o link ou contate o responsável pelo envio.'}
        </p>
      </div>
    );
  }

  return <BriefingRender payload={payload} activeSection={activeSection} />;
};

// =============================================================
// Render do briefing — todo o CSS embutido no JSX.
// =============================================================
const BriefingRender: React.FC<{ payload: BriefingPayload; activeSection: string }> = ({
  payload,
  activeSection,
}) => {
  const b = payload.briefing;
  const lead = b?.lead || {};

  // Descobre quais secoes renderizar (com dados). Q11: esconder secao inteira.
  const sections = useMemo(() => {
    const s: { id: string; num: string; title: string; ico: string }[] = [];
    s.push({ id: 'sumario', num: '01', title: 'Sumário Executivo', ico: '◎' });
    s.push({ id: 'score', num: '02', title: 'Score de Maturidade', ico: '▲' });
    s.push({ id: 'analise', num: '03', title: 'Análise Detalhada', ico: '◇' });
    if (temVisuais(b?.visuais)) s.push({ id: 'visuais', num: '03b', title: 'O que o cliente vê', ico: '▣' });
    s.push({ id: 'gaps', num: '04', title: 'Gaps Identificados', ico: '!' });
    s.push({ id: 'quickwins', num: '05', title: 'Quick Wins', ico: '↗' });
    if (b?.meta_ads) s.push({ id: 'metaads', num: '06', title: 'Meta Ads', ico: '◆' });
    if (b?.google_ads) s.push({ id: 'googleads', num: '07', title: 'Google Ads', ico: '◈' });
    s.push({ id: 'fontes', num: '08', title: 'Fontes', ico: '↗' });
    return s;
  }, [b]);

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <div className="bv-root">
        <nav className="bv-nav">
          <div className="bv-brand">
            <div className="bv-brandmark">V4</div>
            <div>
              <div className="bv-brandname">V4 COMPANY</div>
              <div className="bv-navtag">Briefing Pré-Call</div>
            </div>
          </div>
          <div className="bv-navtag">
            {payload.completed_at
              ? new Date(payload.completed_at).toLocaleDateString('pt-BR')
              : ''}
          </div>
        </nav>

        <section className="bv-hero">
          <div className="bv-herocontent">
            <div className="bv-pill">
              <span className="bv-dot" /> Briefing Pré-Call
            </div>
            <h1 className="bv-herotitle">
              {lead.nome || payload.empresa}
              {lead.tagline && (
                <>
                  <br />
                  <span className="bv-accent">·</span> {lead.tagline}
                </>
              )}
            </h1>
            {lead.tagline_desc && <p className="bv-herosub">{lead.tagline_desc}</p>}
            <div className="bv-herometa">
              <MetaCard label="Segmento" value={lead.segmento || 'Não informado'} />
              <MetaCard label="Faturamento Atual" value={lead.faturamento_atual || 'Não informado'} />
              <MetaCard label="Meta" value={lead.meta_faturamento || 'Não informada'} />
              <MetaCard
                label="Score Digital"
                value={lead.score_geral != null ? `${lead.score_geral.toFixed(1)} / 10` : '—'}
              />
            </div>
          </div>
        </section>

        <div className="bv-layout">
          <aside className="bv-toc">
            <div className="bv-toctitle">Índice</div>
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className={`bv-tocitem ${activeSection === s.id ? 'active' : ''}`}
              >
                <span className="bv-tocnum">{s.num}</span>
                {s.title}
              </a>
            ))}
          </aside>

          <main className="bv-container">
            {/* 01 Sumario */}
            <Sec num="01" title="Sumário Executivo" ico="◎" id="sumario">
              {Array.isArray(b?.sumario_executivo) && b.sumario_executivo.length > 0 ? (
                <TableWrap>
                  <table>
                    <thead>
                      <tr><th>Frente</th><th>Status</th><th>Resumo</th></tr>
                    </thead>
                    <tbody>
                      {b.sumario_executivo.map((r: any, i: number) => (
                        <tr key={i}>
                          <td><strong>{r.frente}</strong></td>
                          <td><StatusChip status={r.status} /></td>
                          <td>{r.resumo}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              ) : (
                <Empty text="Sumário não disponível." />
              )}
            </Sec>

            {/* 02 Score */}
            <Sec num="02" title="Score de Maturidade Digital" ico="▲" id="score">
              {b?.score_maturidade?.dimensoes?.length ? (
                <>
                  <div className="bv-scoregrid">
                    {b.score_maturidade.dimensoes.map((d: any, i: number) => (
                      <ScoreCard key={i} dim={d.nome} nota={d.nota} />
                    ))}
                    <ScoreCard
                      dim="Média Geral"
                      nota={b.score_maturidade.media}
                      main
                    />
                  </div>
                  <div style={{ marginTop: 24 }}>
                    <TableWrap>
                      <table>
                        <thead><tr><th>Dimensão</th><th>Nota</th><th>Evidência</th></tr></thead>
                        <tbody>
                          {b.score_maturidade.dimensoes.map((d: any, i: number) => (
                            <tr key={i}>
                              <td><strong>{d.nome}</strong></td>
                              <td>{d.nota}/10</td>
                              <td>{d.evidencia}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                  </div>
                </>
              ) : (
                <Empty text="Score não disponível." />
              )}
            </Sec>

            {/* 03 Analise */}
            <Sec num="03" title="Análise Detalhada" ico="◇" id="analise">
              <AnaliseDetalhada data={b?.analise_detalhada} />
            </Sec>

            {/* 03b Visuais capturados pelo motor */}
            {temVisuais(b?.visuais) && (
              <Sec num="03b" title="O que o cliente vê" ico="▣" id="visuais">
                <VisuaisSection v={b.visuais} />
              </Sec>
            )}

            {/* 04 Gaps */}
            <Sec num="04" title="Gaps Identificados" ico="!" id="gaps">
              {Array.isArray(b?.gaps) && b.gaps.length > 0 ? (
                <div className="bv-numlist">
                  {b.gaps.map((g: any, i: number) => (
                    <div key={i} className="bv-numitem">
                      <div className="bv-numn">
                        {String(g.numero ?? i + 1).padStart(2, '0')}
                      </div>
                      <div className="bv-numbody">
                        <strong>{g.titulo}</strong>
                        <p>{g.descricao}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty text="Gaps não detalhados." />
              )}
            </Sec>

            {/* 05 Quick Wins */}
            <Sec num="05" title="Quick Wins" ico="↗" id="quickwins">
              {Array.isArray(b?.quick_wins) && b.quick_wins.length > 0 ? (
                <div className="bv-qwgrid">
                  {b.quick_wins.map((q: any, i: number) => (
                    <div key={i} className="bv-qw">
                      <div className="bv-qwhead">
                        <span className="bv-qwnum">QW · {String(q.numero ?? i + 1).padStart(2, '0')}</span>
                        {q.prazo && <span className="bv-qwtime">⏱ {q.prazo}</span>}
                      </div>
                      <h4>{q.titulo}</h4>
                      <p>{q.descricao}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty text="Quick wins não detalhados." />
              )}
            </Sec>

            {/* 06 Meta Ads (opcional) */}
            {b?.meta_ads && (
              <Sec num="06" title="Meta Ads — Análise Profunda" ico="◆" id="metaads">
                <MetaAdsSection data={b.meta_ads} coleta={b?.dados_coleta?.meta_ads} visuais={b?.visuais} />
              </Sec>
            )}

            {/* 07 Google Ads (opcional) */}
            {b?.google_ads && (
              <Sec num="07" title="Google Ads — Análise Profunda" ico="◈" id="googleads">
                <GoogleAdsSection data={b.google_ads} coleta={b?.dados_coleta?.google_ads} />
              </Sec>
            )}

            {/* 08 Fontes */}
            <Sec num="08" title="Fontes Usadas" ico="↗" id="fontes">
              {Array.isArray(b?.fontes) && b.fontes.length > 0 ? (
                <div className="bv-sources">
                  {b.fontes.map((f: any, i: number) => (
                    <div key={i} className="bv-src">
                      <span className="bv-srcico">▸</span>
                      <a href={f.url} target="_blank" rel="noopener noreferrer">{f.url}</a>
                      {f.descricao && <span className="bv-srcdesc">{f.descricao}</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <Empty text="Nenhuma fonte registrada." />
              )}
            </Sec>
          </main>
        </div>

        <footer className="bv-footer">
          <span className="bv-footer-v4">V4 COMPANY</span> · Sales Intelligence · Briefing gerado em{' '}
          {payload.completed_at ? new Date(payload.completed_at).toLocaleDateString('pt-BR') : '—'}
          {payload.version > 1 && ` · versão ${payload.version}`}
        </footer>
      </div>
    </>
  );
};

// ===== helpers =====
const MetaCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bv-metacard">
    <div className="bv-metalabel">{label}</div>
    <div className="bv-metavalue">{value}</div>
  </div>
);

const Sec: React.FC<{ num: string; title: string; ico: string; id: string; children: React.ReactNode }> = ({
  num, title, ico, id, children,
}) => (
  <section className="bv-section" id={id} data-sec={id}>
    <div className="bv-sectionhead">
      <div className="bv-sectiontitle">
        <span className="bv-ico">{ico}</span>
        {title}
      </div>
      <div className="bv-sectionnum">{num}</div>
    </div>
    {children}
  </section>
);

const TableWrap: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="bv-tablewrap">{children}</div>
);

const StatusChip: React.FC<{ status: string }> = ({ status }) => {
  const s = (status || '').toLowerCase();
  const map: Record<string, string> = {
    forte: 'green', madura: 'green', alta: 'green',
    pendente: 'yellow',
    critica: 'red', 'crítica': 'red', baixa: 'red',
  };
  const cls = map[s] || 'gray';
  const label = {
    green: '● ' + (s || ''),
    yellow: '⚠ ' + (s || ''),
    red: '● ' + (s || ''),
    gray: s || '—',
  }[cls];
  return <span className={`bv-chip ${cls}`}>{label}</span>;
};

const ScoreCard: React.FC<{ dim: string; nota: number; main?: boolean }> = ({
  dim, nota, main,
}) => {
  const pct = Math.max(0, Math.min(100, (nota || 0) * 10));
  const chip =
    nota >= 8 ? 'green' : nota >= 5 ? 'yellow' : 'red';
  const chipLabel =
    nota >= 8 ? '⭐ Excelente' : nota >= 5 ? '● Médio' : '● Crítico';
  return (
    <div className={`bv-scorecard ${main ? 'media' : ''}`}>
      <div className="bv-dim">{dim}</div>
      <div className="bv-num">
        {nota != null ? nota.toFixed(nota % 1 === 0 ? 0 : 1) : '—'}
        <small>/10</small>
      </div>
      <span className={`bv-chip ${chip}`}>{chipLabel}</span>
      <div className="bv-progress"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
};

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div className="bv-card" style={{ color: '#B8A6A3', fontStyle: 'italic' }}>{text}</div>
);

const AnaliseDetalhada: React.FC<{ data: any }> = ({ data }) => {
  if (!data) return <Empty text="Análise não disponível." />;
  return (
    <>
      {data.site && (
        <div className="bv-card">
          <h3>Site {data.site.url && <span className="bv-tag">{data.site.url.replace(/https?:\/\//, '')}</span>}</h3>
          <ul>
            {(data.site.pontos || []).map((p: any, i: number) => (
              <li key={i}><strong>{p.label}:</strong> {p.texto}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="bv-grid2">
        {data.instagram && (
          <div className="bv-card">
            <h3>Instagram {data.instagram.handle && <span className="bv-tag">{data.instagram.handle}</span>}</h3>
            <ul>
              {(data.instagram.pontos || []).map((p: any, i: number) => (
                <li key={i}><strong>{p.label}:</strong> {p.texto}</li>
              ))}
            </ul>
          </div>
        )}
        {data.google_meu_negocio && (
          <div className="bv-card">
            <h3>Google Meu Negócio</h3>
            <ul>
              {(data.google_meu_negocio.pontos || []).map((p: any, i: number) => (
                <li key={i}><strong>{p.label}:</strong> {p.texto}</li>
              ))}
            </ul>
          </div>
        )}
        {data.midia_paga && (
          <div className="bv-card">
            <h3>Mídia Paga <span className="bv-tag">visão leve</span></h3>
            <ul>
              {(data.midia_paga.pontos || []).map((p: any, i: number) => (
                <li key={i}><strong>{p.label}:</strong> {p.texto}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
};

// ===== visuais (imagens capturadas pelo motor do Enriquecedor) =====
function temVisuais(v: any): boolean {
  return !!v && !!(v.site?.imagem || v.instagram?.imagem || v.google_ads?.imagem || (Array.isArray(v.meta_ads) && v.meta_ads.length));
}

const semEsquema = (u?: string) => (u || '').replace(/^https?:\/\/(www\.)?/, '');

const Shot: React.FC<{ src: string; titulo: string; href?: string; legenda?: string }> = ({ src, titulo, href, legenda }) => (
  <figure className="bv-shot">
    <div className="bv-shotbar"><span /><span /><span /><em>{titulo}</em></div>
    <a href={href || src} target="_blank" rel="noopener noreferrer">
      <img src={src} alt={titulo} loading="lazy" />
    </a>
    {legenda && <figcaption>{legenda}</figcaption>}
  </figure>
);

const VisuaisSection: React.FC<{ v: any }> = ({ v }) => (
  <>
    <div className="bv-shotgrid">
      {v.site?.imagem && <Shot src={v.site.imagem} titulo="Site" href={v.site.url} legenda={semEsquema(v.site.url)} />}
      {v.instagram?.imagem && <Shot src={v.instagram.imagem} titulo="Instagram" href={v.instagram.url} legenda={semEsquema(v.instagram.url)} />}
      {v.google_ads?.imagem && <Shot src={v.google_ads.imagem} titulo="Google Ads Transparency" href={v.google_ads.url} />}
    </div>
    {Array.isArray(v.meta_ads) && v.meta_ads.length > 0 && (
      <>
        <h3 className="bv-subtitle">Criativos ativos na Biblioteca de Anúncios da Meta</h3>
        <div className="bv-adgallery">
          {v.meta_ads.map((a: any, i: number) => (
            <figure key={i} className="bv-adthumb">
              <img src={a.imagem} alt={`Criativo ${i + 1}`} loading="lazy" />
              <figcaption>
                {a.formato && <span className="bv-chip gray">{a.formato}</span>}
                {a.destino && <span className="bv-chip gray">→ {a.destino}</span>}
                {a.trecho && <p>{a.trecho}</p>}
              </figcaption>
            </figure>
          ))}
        </div>
      </>
    )}
  </>
);

const MetaAdsSection: React.FC<{ data: any; coleta?: any; visuais?: any }> = ({ data, coleta, visuais }) => (
  <>
    <div className="bv-grid3">
      <div className="bv-card">
        <h3>Volume Ativo</h3>
        <p className="bv-bignum">{data.volume ?? 0} ads</p>
        <p>{data.pagina_nome ? `Página "${data.pagina_nome}"` : ''}{data.pagina_id ? ` · ID ${data.pagina_id}` : ''}</p>
        {coleta?.coletado_em && (
          <p className="bv-fonte">
            ⊙ fonte: Meta Ads Library · {new Date(coleta.coletado_em).toLocaleDateString('pt-BR')}
          </p>
        )}
      </div>
      <div className="bv-card">
        <h3>Distribuição por Formato</h3>
        <ul>
          {(data.distribuicao_formato || []).map((f: any, i: number) => (
            <li key={i}><strong>{f.formato}:</strong> {f.qtd} ({f.pct}%) {f.obs && `— ${f.obs}`}</li>
          ))}
        </ul>
      </div>
      <div className="bv-card">
        <h3>Estágio de Funil</h3>
        <ul>
          {(data.estagio_funil || []).map((e: any, i: number) => (
            <li key={i}><strong>{e.estagio}:</strong> {e.descricao}</li>
          ))}
        </ul>
      </div>
    </div>
    {Array.isArray(data.produtos) && data.produtos.length > 0 && (
      <div className="bv-card">
        <h3>Produtos Promovidos</h3>
        <ul>
          {data.produtos.map((p: any, i: number) => (
            <li key={i}><strong>{p.nome}:</strong> {p.qtd_ads} ads — {p.angulo}</li>
          ))}
        </ul>
      </div>
    )}
    {Array.isArray(data.top_criativos) && data.top_criativos.length > 0 && (
      <>
        <h3 className="bv-subtitle">🏆 Top Criativos Campeões</h3>
        {data.top_criativos.map((c: any, i: number) => {
          const img = (visuais?.top_criativos || []).find((x: any) => x.rank === (c.rank ?? i + 1))?.imagem;
          return (
          <div key={i} className={`bv-adcard ${img ? 'comimagem' : ''}`}>
            {img && <img className="bv-adimg" src={img} alt={c.titulo || `Criativo ${i + 1}`} loading="lazy" />}
            <div>
            <div className="bv-adhead">
              <div className="bv-adttl">
                <span className="bv-adrank">#{String(c.rank ?? i + 1).padStart(2, '0')}</span>
                {c.titulo} · {c.formato}{c.data ? ` · ${c.data}` : ''}
              </div>
              {c.cta && <span className="bv-chip green">{c.cta}</span>}
            </div>
            <div className="bv-adbody">
              {c.copy && <div className="bv-adquote">"{c.copy}"</div>}
              {c.por_que && <div className="bv-adwhy"><strong>Por que funciona:</strong> {c.por_que}</div>}
            </div>
            </div>
          </div>
          );
        })}
      </>
    )}
    {Array.isArray(data.gaps_recomendacoes) && data.gaps_recomendacoes.length > 0 && (
      <div className="bv-card">
        <h3>📌 Gaps e Recomendações</h3>
        <ul>
          {data.gaps_recomendacoes.map((r: any, i: number) => (
            <li key={i}><strong>{r.titulo}:</strong> {r.descricao}</li>
          ))}
        </ul>
      </div>
    )}
  </>
);

const GoogleAdsSection: React.FC<{ data: any; coleta?: any }> = ({ data, coleta }) => (
  <>
    <div className="bv-grid3">
      <div className="bv-card">
        <h3>Volume Ativo</h3>
        <p className="bv-bignum">{data.volume ?? 0} ads</p>
        {data.advertiser_id && <p>Advertiser {data.advertiser_id}</p>}
        {coleta?.coletado_em && (
          <p className="bv-fonte">
            ⊙ fonte: Google Ads Transparency · {new Date(coleta.coletado_em).toLocaleDateString('pt-BR')}
          </p>
        )}
      </div>
      <div className="bv-card">
        <h3>Distribuição</h3>
        <ul>
          <li><strong>Search:</strong> {data.distribuicao?.search ?? 0}</li>
          <li><strong>Display:</strong> {data.distribuicao?.display ?? 0}</li>
          <li><strong>YouTube:</strong> {data.distribuicao?.youtube ?? 0}</li>
        </ul>
      </div>
      {data.bandeira_vermelha && (
        <div className="bv-card bv-alerta">
          <h3>🚨 Bandeira Vermelha</h3>
          <p>{data.bandeira_vermelha}</p>
        </div>
      )}
    </div>
    {Array.isArray(data.insights) && data.insights.length > 0 && (
      <div className="bv-numlist">
        {data.insights.map((ins: any, i: number) => (
          <div key={i} className="bv-numitem">
            <div className="bv-numn">#{i + 1}</div>
            <div className="bv-numbody">
              <strong>{ins.titulo}</strong>
              <p>{ins.descricao}</p>
            </div>
          </div>
        ))}
      </div>
    )}
    {Array.isArray(data.gaps_recomendacoes) && data.gaps_recomendacoes.length > 0 && (
      <div className="bv-card">
        <h3>📌 Gaps e Recomendações</h3>
        <ul>
          {data.gaps_recomendacoes.map((r: any, i: number) => (
            <li key={i}><strong>{r.titulo}:</strong> {r.descricao}</li>
          ))}
        </ul>
      </div>
    )}
  </>
);

// =============================================================
// CSS embutido — derivado 1:1 do template HTML do Gabriel.
// Prefixo .bv- pra nao vazar pro resto do app.
// =============================================================
const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');

.bv-root { --v4-fundo:#280000; --v4-fundo2:#1c0000; --v4-cartao:#3D0A05; --v4-cartao2:#4a0f08; --v4-linha:rgba(255,255,255,0.09); --v4-vermelho:#E50914; --v4-vermelho2:#FB2E0A; --v4-amarelo:#FFD60A; --v4-texto:#FFFFFF; --v4-suave:#B8A6A3;
  background:var(--v4-fundo); color:var(--v4-texto); font-family:'IBM Plex Sans',sans-serif; font-weight:400; line-height:1.6; min-height:100vh; -webkit-font-smoothing:antialiased; }
.bv-root * { box-sizing:border-box; margin:0; padding:0; }
.bv-root img { max-width:100%; display:block; }

.bv-nav { position:sticky; top:0; z-index:100; background:rgba(40,0,0,0.88); backdrop-filter:blur(12px); border-bottom:1px solid var(--v4-linha); padding:16px 48px; display:flex; align-items:center; justify-content:space-between; }
.bv-brand { display:flex; align-items:center; gap:14px; font-size:14px; letter-spacing:0.5px; }
.bv-brandmark { width:38px; height:38px; border-radius:6px; background:var(--v4-vermelho); display:grid; place-items:center; font-family:'Anton',sans-serif; font-size:19px; color:#fff; letter-spacing:1px; }
.bv-brandname { font-family:'Anton',sans-serif; font-size:18px; letter-spacing:1.5px; }
.bv-navtag { font-size:11px; color:var(--v4-suave); font-weight:600; text-transform:uppercase; letter-spacing:2px; }

.bv-hero { position:relative; padding:88px 48px 64px; background:radial-gradient(ellipse at 85% 0%, rgba(251,46,10,0.28), transparent 55%), radial-gradient(ellipse at 0% 100%, rgba(229,9,20,0.16), transparent 50%), var(--v4-fundo); border-bottom:1px solid var(--v4-linha); overflow:hidden; }
.bv-hero::after { content:""; position:absolute; right:-80px; top:-80px; width:360px; height:360px; border:48px solid rgba(229,9,20,0.10); border-radius:50%; pointer-events:none; }
.bv-herocontent { position:relative; max-width:1200px; margin:0 auto; }
.bv-pill { display:inline-flex; align-items:center; gap:8px; padding:6px 14px; border-radius:4px; background:var(--v4-amarelo); color:#1c0000; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:2px; margin-bottom:26px; }
.bv-dot { width:7px; height:7px; border-radius:50%; background:var(--v4-vermelho); }
.bv-herotitle { font-family:'Anton',sans-serif; font-weight:400; font-size:clamp(42px,6vw,76px); line-height:1.02; letter-spacing:0.5px; text-transform:uppercase; margin-bottom:20px; }
.bv-accent { color:var(--v4-vermelho2); }
.bv-herosub { font-size:18px; color:#E8DCDA; max-width:780px; margin-bottom:36px; }
.bv-herometa { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; max-width:1200px; margin-top:28px; }
.bv-metacard { background:var(--v4-cartao); border:1px solid var(--v4-linha); border-left:4px solid var(--v4-vermelho); padding:18px 20px; border-radius:6px; }
.bv-metalabel { font-size:11px; text-transform:uppercase; letter-spacing:2px; color:var(--v4-suave); font-weight:600; margin-bottom:6px; }
.bv-metavalue { font-size:16px; font-weight:600; color:#fff; }

.bv-layout { display:grid; grid-template-columns:230px 1fr; max-width:1400px; margin:0 auto; }
.bv-toc { padding:64px 0 64px 32px; position:sticky; top:74px; align-self:start; max-height:calc(100vh - 74px); overflow:auto; }
.bv-toctitle { font-family:'Anton',sans-serif; font-size:14px; text-transform:uppercase; letter-spacing:2px; color:var(--v4-amarelo); margin-bottom:14px; padding-left:12px; }
.bv-tocitem { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:4px; color:var(--v4-suave); text-decoration:none; font-size:13px; font-weight:500; border-left:3px solid transparent; transition:all 0.15s; }
.bv-tocitem:hover { background:rgba(255,255,255,0.04); color:#fff; }
.bv-tocitem.active { background:rgba(229,9,20,0.16); color:#fff; border-left-color:var(--v4-vermelho); }
.bv-tocnum { font-family:'Anton',sans-serif; font-size:13px; color:var(--v4-vermelho2); letter-spacing:1px; }

.bv-container { max-width:1020px; padding:64px 48px; }
.bv-section { margin-bottom:80px; scroll-margin-top:96px; }
.bv-sectionhead { display:flex; align-items:flex-end; justify-content:space-between; margin-bottom:28px; padding-bottom:16px; border-bottom:2px solid var(--v4-vermelho); }
.bv-sectiontitle { font-family:'Anton',sans-serif; font-size:34px; font-weight:400; letter-spacing:0.5px; text-transform:uppercase; display:flex; align-items:center; gap:14px; line-height:1.1; }
.bv-ico { display:inline-grid; place-items:center; width:42px; height:42px; border-radius:6px; background:var(--v4-vermelho); color:#fff; font-size:18px; font-family:'IBM Plex Sans',sans-serif; }
.bv-sectionnum { font-family:'Anton',sans-serif; font-size:28px; color:rgba(255,214,10,0.85); letter-spacing:1px; }
.bv-subtitle { font-family:'Anton',sans-serif; font-weight:400; text-transform:uppercase; letter-spacing:0.5px; font-size:22px; margin:34px 0 16px; }

.bv-tablewrap { border:1px solid var(--v4-linha); border-radius:8px; overflow:hidden; background:var(--v4-cartao); }
.bv-tablewrap table { width:100%; border-collapse:collapse; font-size:14.5px; }
.bv-tablewrap thead th { text-align:left; padding:15px 20px; font-size:11px; text-transform:uppercase; letter-spacing:2px; color:var(--v4-amarelo); font-weight:700; background:rgba(0,0,0,0.25); border-bottom:1px solid var(--v4-linha); }
.bv-tablewrap tbody td { padding:15px 20px; border-bottom:1px solid var(--v4-linha); color:#EFE5E3; vertical-align:top; }
.bv-tablewrap tbody tr:last-child td { border-bottom:none; }
.bv-tablewrap tbody tr:hover { background:rgba(229,9,20,0.08); }
.bv-tablewrap tbody td strong { color:#fff; font-weight:600; }

.bv-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:4px; font-size:12px; font-weight:600; border:1px solid; text-transform:capitalize; }
.bv-chip.green { background:rgba(34,197,94,0.14); color:#86efac; border-color:rgba(34,197,94,0.4); }
.bv-chip.yellow { background:rgba(255,214,10,0.14); color:var(--v4-amarelo); border-color:rgba(255,214,10,0.45); }
.bv-chip.red { background:rgba(229,9,20,0.2); color:#ffb4b0; border-color:rgba(251,46,10,0.55); }
.bv-chip.gray { background:rgba(255,255,255,0.07); color:#EFE5E3; border-color:var(--v4-linha); }

.bv-scoregrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:14px; }
.bv-scorecard { background:var(--v4-cartao); border:1px solid var(--v4-linha); border-radius:8px; padding:22px; position:relative; overflow:hidden; }
.bv-scorecard::before { content:""; position:absolute; top:0; left:0; right:0; height:4px; background:var(--v4-vermelho); }
.bv-scorecard.media { background:var(--v4-vermelho); border-color:var(--v4-vermelho2); }
.bv-scorecard.media::before { background:var(--v4-amarelo); }
.bv-scorecard.media .bv-dim, .bv-scorecard.media .bv-num small { color:rgba(255,255,255,0.85); }
.bv-scorecard.media .bv-progress { background:rgba(0,0,0,0.25); }
.bv-scorecard.media .bv-progress span { background:var(--v4-amarelo); }
.bv-dim { font-size:11px; text-transform:uppercase; letter-spacing:2px; color:var(--v4-suave); font-weight:600; margin-bottom:8px; }
.bv-num { font-family:'Anton',sans-serif; font-size:52px; line-height:1; margin-bottom:10px; color:#fff; }
.bv-num small { font-family:'IBM Plex Sans',sans-serif; font-size:16px; color:var(--v4-suave); font-weight:500; margin-left:4px; }
.bv-progress { height:6px; background:rgba(0,0,0,0.3); border-radius:2px; overflow:hidden; margin-top:12px; }
.bv-progress span { display:block; height:100%; border-radius:2px; background:linear-gradient(90deg,var(--v4-vermelho),var(--v4-vermelho2)); }

.bv-card { background:var(--v4-cartao); border:1px solid var(--v4-linha); border-radius:8px; padding:26px; margin-bottom:14px; }
.bv-card.bv-alerta { border-color:rgba(255,214,10,0.5); box-shadow:inset 4px 0 0 var(--v4-amarelo); }
.bv-card h3 { font-family:'Anton',sans-serif; font-weight:400; font-size:21px; letter-spacing:0.5px; text-transform:uppercase; margin-bottom:14px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.bv-tag { font-family:'IBM Plex Sans',sans-serif; font-size:11px; padding:3px 8px; border-radius:4px; background:rgba(0,0,0,0.3); color:var(--v4-suave); font-weight:600; letter-spacing:1px; text-transform:none; }
.bv-card p { color:#EFE5E3; margin-bottom:10px; font-size:14.5px; }
.bv-card ul { padding-left:0; list-style:none; }
.bv-card li { color:#EFE5E3; font-size:14.5px; padding:8px 0 8px 24px; position:relative; border-bottom:1px solid rgba(255,255,255,0.05); }
.bv-card li:last-child { border-bottom:none; }
.bv-card li::before { content:""; position:absolute; left:4px; top:17px; width:10px; height:3px; background:var(--v4-vermelho2); }
.bv-card li strong { color:#fff; font-weight:600; }
.bv-bignum { font-size:46px !important; font-family:'Anton',sans-serif !important; color:var(--v4-amarelo) !important; line-height:1 !important; margin-bottom:6px !important; }
.bv-fonte { font-size:11px !important; color:var(--v4-suave) !important; margin-top:8px; }

.bv-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.bv-grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-bottom:14px; }

.bv-numlist { display:flex; flex-direction:column; gap:12px; }
.bv-numitem { display:grid; grid-template-columns:64px 1fr; gap:18px; background:var(--v4-cartao); border:1px solid var(--v4-linha); border-radius:8px; padding:22px; transition:border-color 0.2s, transform 0.2s; }
.bv-numitem:hover { border-color:var(--v4-vermelho2); transform:translateX(4px); }
.bv-numn { font-family:'Anton',sans-serif; font-size:40px; color:var(--v4-vermelho2); line-height:1; }
.bv-numbody strong { display:block; color:#fff; font-size:16px; margin-bottom:6px; font-weight:600; }
.bv-numbody p { color:#EFE5E3; font-size:14.5px; margin:0; }

.bv-qwgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:14px; }
.bv-qw { background:var(--v4-cartao); border:1px solid var(--v4-linha); border-top:4px solid var(--v4-amarelo); border-radius:8px; padding:24px; }
.bv-qwhead { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
.bv-qwnum { font-family:'Anton',sans-serif; color:var(--v4-amarelo); font-size:16px; letter-spacing:1px; }
.bv-qwtime { font-size:12px; padding:3px 10px; background:rgba(229,9,20,0.22); border:1px solid rgba(251,46,10,0.5); color:#fff; border-radius:4px; font-weight:600; }
.bv-qw h4 { font-family:'IBM Plex Sans',sans-serif; font-size:17px; font-weight:700; margin-bottom:10px; color:#fff; }
.bv-qw p { color:#EFE5E3; font-size:14px; margin:0; }

.bv-adcard { background:var(--v4-cartao); border:1px solid var(--v4-linha); border-radius:8px; overflow:hidden; margin-bottom:14px; }
.bv-adcard.comimagem { display:grid; grid-template-columns:220px 1fr; }
.bv-adimg { width:100%; height:100%; max-height:320px; object-fit:cover; background:#000; }
.bv-adhead { display:flex; justify-content:space-between; align-items:center; padding:15px 22px; background:rgba(0,0,0,0.25); border-bottom:1px solid var(--v4-linha); gap:12px; flex-wrap:wrap; }
.bv-adttl { font-weight:600; font-size:15px; }
.bv-adrank { font-family:'Anton',sans-serif; color:var(--v4-amarelo); margin-right:8px; font-size:18px; }
.bv-adbody { padding:20px 22px; }
.bv-adquote { background:rgba(0,0,0,0.22); border-left:4px solid var(--v4-vermelho); padding:14px 18px; border-radius:4px; font-style:italic; color:#EFE5E3; font-size:14.5px; margin-bottom:14px; }
.bv-adwhy { color:#EFE5E3; font-size:14px; }
.bv-adwhy strong { color:var(--v4-amarelo); }

.bv-shotgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; }
.bv-shot { background:var(--v4-cartao); border:1px solid var(--v4-linha); border-radius:8px; overflow:hidden; }
.bv-shotbar { display:flex; align-items:center; gap:6px; padding:9px 12px; background:rgba(0,0,0,0.35); border-bottom:1px solid var(--v4-linha); }
.bv-shotbar span { width:9px; height:9px; border-radius:50%; background:rgba(255,255,255,0.18); }
.bv-shotbar span:first-child { background:var(--v4-vermelho); }
.bv-shotbar em { font-style:normal; font-size:11px; color:var(--v4-suave); letter-spacing:1.5px; text-transform:uppercase; margin-left:8px; font-weight:600; }
.bv-shot img { width:100%; aspect-ratio:16/10; object-fit:cover; object-position:top; }
.bv-shot figcaption { padding:10px 14px; font-size:12.5px; color:var(--v4-suave); word-break:break-all; }
.bv-adgallery { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:14px; }
.bv-adthumb { background:var(--v4-cartao); border:1px solid var(--v4-linha); border-radius:8px; overflow:hidden; }
.bv-adthumb img { width:100%; aspect-ratio:1/1; object-fit:cover; background:#000; }
.bv-adthumb figcaption { padding:10px 12px; display:flex; flex-wrap:wrap; gap:6px; }
.bv-adthumb figcaption p { width:100%; font-size:12.5px; color:#EFE5E3; margin-top:4px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }

.bv-sources { display:flex; flex-direction:column; gap:8px; }
.bv-src { display:flex; gap:12px; align-items:center; padding:12px 16px; background:var(--v4-cartao); border:1px solid var(--v4-linha); border-radius:6px; transition:border-color 0.2s; }
.bv-src:hover { border-color:var(--v4-vermelho2); }
.bv-srcico { color:var(--v4-vermelho2); font-size:14px; }
.bv-src a { color:#fff; text-decoration:none; font-size:13.5px; word-break:break-all; flex:1; }
.bv-src a:hover { color:var(--v4-amarelo); }
.bv-srcdesc { color:var(--v4-suave); font-size:13px; }

.bv-footer { border-top:4px solid var(--v4-vermelho); padding:36px 48px; text-align:center; color:var(--v4-suave); font-size:13px; background:var(--v4-fundo2); }
.bv-footer-v4 { color:#fff; letter-spacing:1.5px; font-family:'Anton',sans-serif; font-size:16px; }

@media (max-width:980px) {
  .bv-layout { grid-template-columns:1fr; }
  .bv-toc { position:static; padding:32px 16px 0; max-height:none; }
  .bv-container { padding:32px 16px; }
  .bv-grid2, .bv-grid3 { grid-template-columns:1fr; }
  .bv-adcard.comimagem { grid-template-columns:1fr; }
  .bv-nav, .bv-hero { padding-left:16px; padding-right:16px; }
  .bv-sectiontitle { font-size:26px; }
}

@media print {
  .bv-nav, .bv-toc, .bv-footer { display:none; }
  .bv-layout { grid-template-columns:1fr; }
  .bv-hero { padding:40px 24px 24px; }
  .bv-container { padding:24px; max-width:100%; }
  .bv-section { page-break-inside:avoid; }
  .bv-root { background:#fff; color:#000; }
  .bv-card, .bv-scorecard, .bv-numitem, .bv-qw, .bv-adcard, .bv-tablewrap, .bv-src, .bv-metacard, .bv-shot, .bv-adthumb { background:#fff !important; border-color:#ddd !important; color:#000 !important; }
  .bv-card *, .bv-numbody p, .bv-qw p, .bv-tablewrap tbody td, .bv-src a { color:#222 !important; }
  .bv-num, .bv-numn, .bv-qwnum, .bv-bignum, .bv-adrank, .bv-footer-v4, .bv-accent, .bv-tocnum { color:#E50914 !important; }
}
`;

const styles = {
  fullScreen: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    backgroundColor: '#280000',
    color: '#fff',
    padding: 24,
  },
};
