import toast from 'react-hot-toast';

// Detector de versão nova: a SPA não recarrega sozinha depois de um deploy, e uma
// aba aberta antes dele continua rodando o bundle antigo (foi assim que "avançar"
// pareceu não rodar a fase). A cada 5 min e ao ganhar foco, lê o index.html de
// produção e compara o nome do bundle com o carregado; mudou → avisa e, se não
// houver nada em edição, recarrega sozinho (o estado vive no banco, nada se perde).
const BASE = import.meta.env.BASE_URL || '/';
const RE_BUNDLE = /assets\/index-[A-Za-z0-9_-]+\.js/;

function bundleCarregado(): string | null {
  const s = Array.from(document.querySelectorAll('script[src]')).map((e) => e.getAttribute('src') ?? '').find((src) => RE_BUNDLE.test(src));
  return s ? (s.match(RE_BUNDLE)?.[0] ?? null) : null;
}

async function bundleNoAr(): Promise<string | null> {
  try {
    const r = await fetch(`${BASE}index.html?v=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.text()).match(RE_BUNDLE)?.[0] ?? null;
  } catch {
    return null;
  }
}

let avisado = false;
export function vigiarVersao(): () => void {
  if (import.meta.env.DEV) return () => {};
  const atual = bundleCarregado();
  if (!atual) return () => {};
  const checa = async () => {
    if (avisado) return;
    const novo = await bundleNoAr();
    if (!novo || novo === atual) return;
    avisado = true;
    const editando = !!document.querySelector('input:focus, textarea:focus, [contenteditable]:focus');
    if (!editando) {
      toast('Nova versão no ar — recarregando…', { icon: '⟳', duration: 2500 });
      setTimeout(() => window.location.reload(), 1500);
      return;
    }
    // em edição: não interrompe — avisa e deixa recarregar quando terminar
    toast('Nova versão no ar — recarregue a página (F5) para pegar as correções.', { icon: '⟳', duration: Infinity, id: 'versao-nova' });
  };
  const t = setInterval(() => void checa(), 5 * 60_000);
  const onFoco = () => void checa();
  window.addEventListener('focus', onFoco);
  void checa();
  return () => {
    clearInterval(t);
    window.removeEventListener('focus', onFoco);
  };
}
