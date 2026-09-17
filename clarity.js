/* Microsoft Clarity — mapa de calor e gravação de sessões.
   Projeto Clarity ÚNICO para todo o ecossistema VozUP/Instituto UP; o ID é
   carimbado em todos os repos por tools/set-clarity-id.sh na raiz do monorepo.
   Enquanto o placeholder não for substituído, este arquivo é um no-op. */
(function () {
  var CLARITY_ID = "xonuuydq5e";
  if (!CLARITY_ID || CLARITY_ID.indexOf("__") === 0) return;

  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  })(window, document, "clarity", "script", CLARITY_ID);

  /* Tag de produto para filtrar as sessoes desta pesquisa no Clarity.
     Aqui nao ha tag de anuncio/campanha: esta pagina e respondida no fim do
     workshop, nao e destino de trafego pago. */
  try {
    window.clarity("set", "produto", "Avaliacao Workshop");
  } catch (e) { /* analytics nunca pode quebrar a página */ }
})();
