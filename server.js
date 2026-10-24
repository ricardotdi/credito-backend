const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const SibApiV3Sdk = require("sib-api-v3-sdk");
const rateLimit = require("express-rate-limit");
const https = require("https");

const app = express();

// O Render corre atrás de um proxy. Sem isto o rate limit e o remoteip do
// Turnstile veem sempre o mesmo IP para todos os visitantes.
app.set("trust proxy", 1);

// Mas há dois saltos, não um: o Render está alojado atrás da Cloudflare, pelo
// que o req.ip do Express acaba a ser um IP de borda da Cloudflare, diferente
// a cada pedido (172.64.0.0/13). Isso tornava os limitadores inúteis, porque
// cada pedido caía num contador novo, e escrevia IPs sem valor nos logs.
// O CF-Connecting-IP traz o IP real e é reescrito pela Cloudflare em todos os
// pedidos que a atravessam, por isso não pode ser forjado pelo visitante.
function ipDoCliente(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  return req.ip;
}

// ─────────────────────────────────────────────
// CORS — restrito às origens da Bruma Finance
// ─────────────────────────────────────────────
// O site finmais.pt e o links.finmais.pt foram desligados a 08/10/2026, com o
// rebranding, por isso as suas origens saíram daqui. O endereço pages.dev é o
// do projecto Cloudflare Pages, usado nas pré-visualizações.
const allowedOrigins = [
  "https://brumafinance.pt",
  "https://www.brumafinance.pt",
  "https://bruma-finance.pages.dev",
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
}));

// 1mb chega com folga: os maiores pedidos JSON são as simulações, com poucos KB.
app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ limit: "1mb", extended: true }));

// ─────────────────────────────────────────────
// BREVO CONFIG (SDK — widgets existentes)
// ─────────────────────────────────────────────
let defaultClient = SibApiV3Sdk.ApiClient.instance;
let apiKey = defaultClient.authentications["api-key"];
apiKey.apiKey = process.env.BREVO_API_KEY;
const brevo = new SibApiV3Sdk.TransactionalEmailsApi();

// Marca e remetente dos emails. O site passou a Bruma Finance; ficam em
// variáveis de ambiente para mudar de marca ou de endereço sem novo deploy de
// código. O endereço tem de estar verificado no Brevo, senão o envio falha.
const MARCA = process.env.SENDER_NAME || "Bruma Finance";
const MARCA_EMAIL = process.env.SENDER_EMAIL || "geral@brumafinance.pt";
const REMETENTE = { name: MARCA, email: MARCA_EMAIL };

// Assinatura dos emails de confirmação ao cliente. O logótipo vem por URL do
// site e não embebido em base64, porque o Gmail e o Outlook descartam imagens
// data: nas mensagens recebidas, e a assinatura apareceria partida.
const ASSINATURA = `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:620px;max-width:100%;color:#333;font-family:Arial,Helvetica,sans-serif;margin-top:16px;">
            <tr>
              <td valign="middle" style="width:94px;padding:0 18px 0 0;">
                <img src="https://brumafinance.pt/assets/assinatura-bruma.png" width="78" height="78" alt="${MARCA}" style="display:block;width:78px;height:78px;border:0;outline:none;text-decoration:none;" />
              </td>
              <td valign="middle" style="border-left:1px solid #b7b7b7;padding:0 0 0 16px;">
                <div style="font-size:15px;line-height:19px;font-weight:bold;color:#20242a;">Ricardo Custódio</div>
                <div style="font-size:12px;line-height:17px;color:#666;">Intermediário de Crédito - ${MARCA}</div>
                <div style="font-size:12px;line-height:18px;color:#444;margin-top:1px;">Tel / WhatsApp: <span style="color:#222;">911 511 908</span></div>
                <div style="font-size:12px;line-height:17px;"><a href="https://www.brumafinance.pt" style="color:#176343;text-decoration:none;font-weight:bold;">www.brumafinance.pt</a></div>
                <div style="font-size:12px;line-height:17px;color:#555;">Continente, Madeira e Açores</div>
                <div style="font-size:9px;line-height:13px;color:#8a8a8a;margin-top:3px;">Intermediário de Crédito registado no Banco de Portugal sob o n.º 0008693</div>
              </td>
            </tr>
          </table>`;

// Destinatários das leads dos formulários. Estavam fixos no código, o que
// obrigava a um deploy para mudar um endereço. Passam a vir de variáveis de
// ambiente, com estes valores por omissão.
const LEADS_TO = process.env.LEADS_TO || "geral@brumafinance.pt";
const LEADS_CC = process.env.LEADS_CC || "geral.brumafinance@gmail.com";
console.log(`Leads enviadas para ${LEADS_TO}, com cópia para ${LEADS_CC}`);

// ─────────────────────────────────────────────
// ANTI-SPAM DOS FORMULÁRIOS (rate limit + honeypot + Turnstile + escaping)
// ─────────────────────────────────────────────
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
// Modo suave por omissão: um token em falta apenas gera aviso no log.
// Só depois de o frontend estar em produção é que se põe TURNSTILE_ENFORCE=true.
const TURNSTILE_ENFORCE = process.env.TURNSTILE_ENFORCE === "true";

const leadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipDoCliente,
  message: { success: false, message: "Demasiados pedidos enviados. Tente novamente dentro de alguns minutos." },
});

// Valida o token do Cloudflare Turnstile. Usa o módulo https nativo para não
// depender da versão de Node do Render (fetch global só existe a partir do 18).
function verifyTurnstile(token, ip) {
  return new Promise((resolve) => {
    if (!TURNSTILE_SECRET || !token) return resolve(false);
    const payload = new URLSearchParams({
      secret: TURNSTILE_SECRET,
      response: token,
      ...(ip ? { remoteip: ip } : {}),
    }).toString();

    const request = https.request({
      hostname: "challenges.cloudflare.com",
      path: "/turnstile/v0/siteverify",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 8000,
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body).success === true);
        } catch (e) {
          console.error("Turnstile: resposta inválida", body);
          resolve(false);
        }
      });
    });

    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.on("error", (err) => { console.error("Turnstile: erro de rede", err.message); resolve(false); });
    request.write(payload);
    request.end();
  });
}

// Escapa HTML. Não escapa a plica, para não estragar nomes tipo O'Brien nos
// emails, já que todos os campos são interpolados em texto, nunca dentro de atributos.
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Escapa recursivamente todas as strings do corpo do pedido, exceto o email
// (que é validado por regex e usado como endereço de destino real).
function escapeBody(value, key) {
  if (typeof value === "string") return key === "email" ? value : escHtml(value);
  if (Array.isArray(value)) return value.map((v) => escapeBody(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = escapeBody(value[k], k);
    return out;
  }
  return value;
}

// A plica é permitida (o'brien@exemplo.pt é válido); só bloqueamos os
// caracteres que teriam significado em HTML, já que o email não é escapado.
const EMAIL_RE = /^[^\s@<>"&]+@[^\s@<>"&,]+\.[a-zA-Z]{2,}$/;
const TELEFONE_RE = /^[\d\s+().-]{6,25}$/;

// Resposta de falso sucesso: o bot fica convencido de que passou e não tenta
// variações, mas nenhum email é enviado.
function fakeSuccess(res, motivo, req) {
  console.warn(`Lead bloqueada (${motivo}), IP ${ipDoCliente(req)}`);
  return res.json({ success: true });
}

async function leadGuard(req, res, next) {
  const body = req.body || {};

  // 1. Honeypot: campo escondido que só um bot preenche.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return fakeSuccess(res, "honeypot", req);
  }

  // 2. Tempo mínimo entre carregar a página e submeter.
  const ts = Number(body.ts);
  if (ts && Date.now() - ts < 3000) {
    return fakeSuccess(res, "submissão demasiado rápida", req);
  }

  // 3. Validação básica dos campos.
  const nome = typeof body.nome === "string" ? body.nome.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const telefone = typeof body.telefone === "string" ? body.telefone.trim() : "";
  const mensagem = typeof body.mensagem === "string" ? body.mensagem : "";

  if (nome.length < 2 || nome.length > 80) {
    return res.status(400).json({ success: false, message: "Nome inválido." });
  }
  if (/https?:|:\/\/|[\r\n]/i.test(nome) || /https?:|:\/\/|[\r\n]/i.test(telefone)) {
    return fakeSuccess(res, "links no nome/telefone", req);
  }
  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, message: "Email inválido." });
  }
  if (telefone && !TELEFONE_RE.test(telefone)) {
    return res.status(400).json({ success: false, message: "Telefone inválido." });
  }
  if (mensagem.length > 2000) {
    return res.status(400).json({ success: false, message: "Mensagem demasiado longa." });
  }

  // 4. Turnstile.
  const ok = await verifyTurnstile(body.turnstileToken, ipDoCliente(req));
  if (!ok) {
    if (TURNSTILE_ENFORCE) {
      return res.status(403).json({ success: false, message: "Verificação de segurança falhou. Recarregue a página e tente novamente." });
    }
    console.warn(`Turnstile sem validação (modo suave), IP ${ipDoCliente(req)}`);
  }

  // Campos de controlo não devem chegar aos emails.
  delete body.website;
  delete body.ts;
  delete body.turnstileToken;

  req.body = escapeBody(body);
  next();
}

// ─────────────────────────────────────────────
// ROTA LEADS
// ─────────────────────────────────────────────
app.post("/send-email", leadLimiter, leadGuard, async (req, res) => {
  try {
    const {
      nome, email, telefone, horario, simulador, mensagem,
      valorCredito, prazo, carencia, tipoCredito, tipoTaxa,
      rendimentoLiquido, dsti,
      rendimento, outrasPrestacoes, montanteMaximo,
      valorCompra, imt, totalImpostos, tabelaAplicada
    } = req.body;

    const formatEuro = (val) => {
      const num = parseFloat(String(val).replace(/[^\d.,]/g, "").replace(",", "."));
      if (isNaN(num)) return val;
      return num.toLocaleString("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const valorCreditoFmt = valorCredito ? formatEuro(valorCredito) : "";
    const rendimentoFmt = rendimentoLiquido ? formatEuro(rendimentoLiquido) : (rendimento ? formatEuro(rendimento) : "");
    const outrasFmt = outrasPrestacoes ? formatEuro(outrasPrestacoes) : "";
    const valorCompraFmt = valorCompra ? formatEuro(valorCompra) : "";

    const temResumo = !!(valorCreditoFmt || prazo || tipoTaxa || montanteMaximo || valorCompraFmt || imt || totalImpostos);

    const resumoSimulacao = `
      ${montanteMaximo ? `<p><strong>Montante máximo financiável:</strong> ${montanteMaximo}</p>` : ""}
      ${valorCompraFmt ? `<p><strong>Valor de compra do imóvel:</strong> ${valorCompraFmt}</p>` : ""}
      ${valorCreditoFmt ? `<p><strong>Valor do crédito:</strong> ${valorCreditoFmt}</p>` : ""}
      ${tipoCredito ? `<p><strong>Tipo de Crédito:</strong> ${tipoCredito}</p>` : ""}
      ${prazo ? `<p><strong>Prazo:</strong> ${prazo}</p>` : ""}
      ${carencia ? `<p><strong>Carência de capital:</strong> ${carencia}</p>` : ""}
      ${tipoTaxa ? `<p><strong>Tipo de Taxa:</strong> ${tipoTaxa}</p>` : ""}
      ${rendimentoFmt ? `<p><strong>Rendimento Líquido Mensal:</strong> ${rendimentoFmt}</p>` : ""}
      ${outrasFmt ? `<p><strong>Outras prestações mensais:</strong> ${outrasFmt}</p>` : ""}
      ${dsti ? `<p><strong>Taxa de Esforço e DSTI:</strong> ${dsti}</p>` : ""}
      ${imt ? `<p><strong>IMT:</strong> ${imt}</p>` : ""}
      ${totalImpostos ? `<p><strong>Total de Impostos (IMT + IS):</strong> ${totalImpostos}</p>` : ""}
      ${tabelaAplicada ? `<p><strong>Tabela aplicada:</strong> ${tabelaAplicada}</p>` : ""}
    `;

    const htmlInterno = `
      <h2>Novo pedido de contacto / simulação</h2>
      ${simulador ? `<p><strong>Simulador:</strong> ${simulador}</p>` : ""}
      <p><strong>Nome:</strong> ${nome}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Telefone:</strong> ${telefone}</p>
      <p><strong>Horário preferencial de contacto:</strong> ${horario || "Qualquer hora"}</p>
      ${mensagem ? `<p><strong>Assunto / Mensagem:</strong> ${mensagem}</p>` : ""}
      ${resumoSimulacao}
    `;

    await brevo.sendTransacEmail({
      sender: REMETENTE,
      to: [{ email: LEADS_TO }],
      cc: [{ email: LEADS_CC }],
      subject: simulador ? `Novo pedido de contacto — ${nome} (${simulador})` : `Novo pedido de contacto — ${nome}`,
      htmlContent: htmlInterno
    });

    if (email) {
      const horarioTexto = horario && horario !== "qualquer"
        ? ", preferencialmente <strong>" + horario + "</strong>"
        : "";

      const introTexto = temResumo
        ? `Obrigado pelo seu contacto. Recebemos a sua simulação${simulador ? ` de <strong>${simulador}</strong>` : ""} e entraremos em contacto consigo em breve${horarioTexto} através do número <strong>${telefone || "indicado"}</strong>.`
        : `Obrigado por nos contactar. Entraremos em contacto consigo em breve${horarioTexto} através do número <strong>${telefone || "indicado"}</strong>.`;

      const htmlCliente = `
        <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; color:#333;">
          <h2 style="color:#153A26;">Recebemos o seu pedido!</h2>
          <p>Olá <strong>${nome}</strong>,</p>
          <p>${introTexto}</p>
          ${mensagem ? `<p><strong>O seu assunto:</strong> ${mensagem}</p>` : ""}
          ${temResumo ? `
            <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
            <h3 style="color:#153A26;">Resumo da sua simulação</h3>
            ${resumoSimulacao}
          ` : ""}
          <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
          <p style="font-size:12px; color:#999;">Os seus dados são tratados de forma confidencial e não serão partilhados com terceiros.</p>
          <p style="font-size:13px;">Com os melhores cumprimentos,</p>${ASSINATURA}
        </div>
      `;

      await brevo.sendTransacEmail({
        sender: REMETENTE,
        to: [{ email: email, name: nome }],
        subject: temResumo ? `A sua simulação ${MARCA} — confirmação de pedido` : `O seu contacto ${MARCA} — confirmação de receção`,
        htmlContent: htmlCliente
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar email:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────
// ROTA CRÉDITO CONSOLIDADO
// ─────────────────────────────────────────────
app.post("/send-email-consolidado", leadLimiter, leadGuard, async (req, res) => {
  try {
    const {
      nome, email, telefone, horario,
      creditosConsolidar,
      valorImovel, novoPrazo, tipoTaxa, dadosTaxa,
      montanteExtra, rendimentoLiquido, encargosAtuais,
      capitalConsolidado, novaPrestacao, prestacaoAtual,
      tan, taeg, mtic, poupancaMensal,
      dstiAntes, dstiDepois
    } = req.body;

    const tipoLabel = { variavel: "Variável", fixa: "Fixa", mista: "Mista" }[tipoTaxa] || tipoTaxa;
    let htmlTaxa = `<p><strong>Tipo de taxa:</strong> ${tipoLabel}</p>`;
    if (tipoTaxa === "variavel") {
      if (dadosTaxa?.euribor) htmlTaxa += `<p><strong>Taxa Euribor:</strong> ${dadosTaxa.euribor}</p>`;
      if (dadosTaxa?.spread) htmlTaxa += `<p><strong>Spread:</strong> ${dadosTaxa.spread}</p>`;
    } else if (tipoTaxa === "fixa") {
      if (dadosTaxa?.tanFixo) htmlTaxa += `<p><strong>TAN fixo:</strong> ${dadosTaxa.tanFixo}</p>`;
    } else if (tipoTaxa === "mista") {
      htmlTaxa += `<p><strong>Fase fixa — Prazo:</strong> ${dadosTaxa?.prazoFixo || "—"} &nbsp;|&nbsp; <strong>TAN:</strong> ${dadosTaxa?.tanFixo || "—"}</p>`;
      htmlTaxa += `<p><strong>Fase variável — Prazo:</strong> ${dadosTaxa?.prazoVar || "—"} &nbsp;|&nbsp; <strong>Euribor:</strong> ${dadosTaxa?.euribor || "—"} &nbsp;|&nbsp; <strong>Spread:</strong> ${dadosTaxa?.spread || "—"}</p>`;
    }

    const htmlInterno = `
      <h2 style="color:#153A26;">🔔 Novo pedido — Crédito Consolidado</h2>
      <h3>Dados do cliente</h3>
      <p><strong>Nome:</strong> ${nome}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Telemóvel:</strong> ${telefone}</p>
      <p><strong>Horário preferencial:</strong> ${horario || "Qualquer hora"}</p>
      <hr/>
      <h3>Créditos a consolidar</h3>
      ${(creditosConsolidar || "").split(" | ").map(c => `<p>• ${c}</p>`).join("")}
      <p><strong>Prestação atual total:</strong> ${prestacaoAtual || "—"}</p>
      <p><strong>Encargos mensais atuais:</strong> ${encargosAtuais || "—"}</p>
      <hr/>
      <h3>Imóvel em garantia</h3>
      <p><strong>Valor do imóvel:</strong> ${valorImovel || "—"}</p>
      <hr/>
      <h3>Novo crédito consolidado</h3>
      <p><strong>Prazo pretendido:</strong> ${novoPrazo || "—"}</p>
      ${htmlTaxa}
      ${montanteExtra ? `<p><strong>Montante extra:</strong> ${montanteExtra}</p>` : ""}
      <hr/>
      <h3>Rendimento</h3>
      <p><strong>Rendimento líquido mensal:</strong> ${rendimentoLiquido || "—"}</p>
      <p><strong>Taxa de esforço antes (DSTI):</strong> ${dstiAntes || "—"}</p>
      <p><strong>Taxa de esforço depois (DSTI):</strong> ${dstiDepois || "—"}</p>
      <hr/>
      <h3>Resultados da simulação</h3>
      <p><strong>Capital consolidado:</strong> ${capitalConsolidado || "—"}</p>
      <p><strong>Nova prestação:</strong> ${novaPrestacao || "—"}</p>
      <p><strong>TAN:</strong> ${tan || "—"}</p>
      <p><strong>TAEG:</strong> ${taeg || "—"}</p>
      <p><strong>MTIC (custo total):</strong> ${mtic || "—"}</p>
      <p><strong>Poupança mensal:</strong> ${poupancaMensal || "—"}</p>
    `;

    await brevo.sendTransacEmail({
      sender: REMETENTE,
      to: [{ email: LEADS_TO }],
      cc: [{ email: LEADS_CC }],
      subject: `Novo pedido Crédito Consolidado — ${nome}`,
      htmlContent: htmlInterno
    });

    const horarioTexto = horario && horario !== "Qualquer hora"
      ? `, preferencialmente <strong>${horario}</strong>`
      : "";

    const htmlCliente = `
      <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; color:#333;">
        <h2 style="color:#153A26;">Recebemos o seu pedido!</h2>
        <p>Olá <strong>${nome}</strong>,</p>
        <p>Obrigado pelo seu contacto. Recebemos a sua simulação de consolidação de crédito e entraremos em contacto consigo em breve${horarioTexto}.</p>
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <h3 style="color:#153A26;">Resumo da sua simulação</h3>
        <p><strong>Créditos a consolidar:</strong></p>
        ${(creditosConsolidar || "").split(" | ").map(c => `<p style="margin:2px 0;">• ${c}</p>`).join("")}
        <p><strong>Valor do imóvel em garantia:</strong> ${valorImovel || "—"}</p>
        <p><strong>Prazo pretendido:</strong> ${novoPrazo || "—"}</p>
        ${htmlTaxa}
        ${montanteExtra ? `<p><strong>Montante extra solicitado:</strong> ${montanteExtra}</p>` : ""}
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <h3 style="color:#153A26;">Resultado indicativo</h3>
        <p><strong>Capital consolidado:</strong> ${capitalConsolidado || "—"}</p>
        <p><strong>Nova prestação mensal:</strong> ${novaPrestacao || "—"}</p>
        <p><strong>Prestação atual total:</strong> ${prestacaoAtual || "—"}</p>
        <p><strong>Poupança mensal estimada:</strong> ${poupancaMensal || "—"}</p>
        <p><strong>TAN:</strong> ${tan || "—"} &nbsp;|&nbsp; <strong>TAEG:</strong> ${taeg || "—"}</p>
        <p><strong>MTIC (custo total estimado):</strong> ${mtic || "—"}</p>
        <p><strong>Taxa de esforço antes:</strong> ${dstiAntes || "—"} &nbsp;→&nbsp; <strong>depois:</strong> ${dstiDepois || "—"}</p>
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <p style="font-size:12px; color:#999;">Valores meramente indicativos, sujeitos a análise e aprovação bancária.</p>
        <p style="font-size:13px;">Com os melhores cumprimentos,</p>${ASSINATURA}
      </div>
    `;

    await brevo.sendTransacEmail({
      sender: REMETENTE,
      to: [{ email: email, name: nome }],
      subject: `A sua simulação de Crédito Consolidado — ${MARCA}`,
      htmlContent: htmlCliente
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar email consolidado:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────
// ROTA CRÉDITO MULTIOPÇÕES
// ─────────────────────────────────────────────
app.post("/send-email-multiopcoes", leadLimiter, leadGuard, async (req, res) => {
  try {
    const {
      nome, email, telefone, horario,
      finalidade,
      hipotecaInscrita, capitalAtual, prazoRemanescente,
      idadeProponente1, idadeProponente2,
      montanteLibertar, novoPrazo, tipoTaxa, dadosTaxa,
      rendimentoLiquido, encargosAtuais,
      capitalTotalFinanciado, novaPrestacao, prestacaoAtual,
      tan, taeg, mtic, variacaoPrestacaoMensal,
      dstiAntes, dstiDepois, dstiNovo
    } = req.body;

    const tipoLabel = { variavel: "Variável", fixa: "Fixa", mista: "Mista" }[tipoTaxa] || tipoTaxa;
    let htmlTaxa = `<p><strong>Tipo de taxa:</strong> ${tipoLabel}</p>`;
    if (tipoTaxa === "variavel") {
      if (dadosTaxa?.euribor) htmlTaxa += `<p><strong>Taxa Euribor:</strong> ${dadosTaxa.euribor}</p>`;
      if (dadosTaxa?.spread) htmlTaxa += `<p><strong>Spread:</strong> ${dadosTaxa.spread}</p>`;
    } else if (tipoTaxa === "fixa") {
      if (dadosTaxa?.tanFixo) htmlTaxa += `<p><strong>TAN fixo:</strong> ${dadosTaxa.tanFixo}</p>`;
    } else if (tipoTaxa === "mista") {
      htmlTaxa += `<p><strong>Fase fixa — Prazo:</strong> ${dadosTaxa?.prazoFixo || "—"} &nbsp;|&nbsp; <strong>TAN:</strong> ${dadosTaxa?.tanFixo || "—"}</p>`;
      htmlTaxa += `<p><strong>Fase variável — Prazo:</strong> ${dadosTaxa?.prazoVar || "—"} &nbsp;|&nbsp; <strong>Euribor:</strong> ${dadosTaxa?.euribor || "—"} &nbsp;|&nbsp; <strong>Spread:</strong> ${dadosTaxa?.spread || "—"}</p>`;
    }

    const idadesTexto = idadeProponente2
      ? `${idadeProponente1 || "—"} anos / ${idadeProponente2} anos`
      : `${idadeProponente1 || "—"} anos`;

    const htmlInterno = `
      <h2 style="color:#153A26;">🔔 Novo pedido — Crédito Multiopções</h2>
      <h3>Dados do cliente</h3>
      <p><strong>Nome:</strong> ${nome}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Telemóvel:</strong> ${telefone}</p>
      <p><strong>Horário preferencial:</strong> ${horario || "Qualquer hora"}</p>
      <hr/>
      <h3>Crédito habitação atual</h3>
      <p><strong>Valor da hipoteca inscrita:</strong> ${hipotecaInscrita || "—"}</p>
      <p><strong>Capital em dívida atual:</strong> ${capitalAtual || "—"}</p>
      <p><strong>Prestação atual:</strong> ${prestacaoAtual || "—"}</p>
      <p><strong>Prazo remanescente:</strong> ${prazoRemanescente || "—"}</p>
      <p><strong>Idade dos proponentes:</strong> ${idadesTexto}</p>
      <hr/>
      <h3>Novo crédito multiopções</h3>
      <p><strong>Finalidade:</strong> ${finalidade || "—"}</p>
      <p><strong>Montante a libertar:</strong> ${montanteLibertar || "—"}</p>
      <p><strong>Prazo pretendido:</strong> ${novoPrazo || "—"}</p>
      ${htmlTaxa}
      <hr/>
      <h3>Rendimento</h3>
      <p><strong>Rendimento líquido mensal:</strong> ${rendimentoLiquido || "—"}</p>
      <p><strong>Encargos mensais atuais:</strong> ${encargosAtuais || "—"}</p>
      <p><strong>Taxa de esforço antes (DSTI):</strong> ${dstiAntes || "—"}</p>
      <p><strong>Taxa de esforço depois (DSTI):</strong> ${dstiDepois || "—"}</p>
      <p><strong>DSTI do novo crédito (stress BdP):</strong> ${dstiNovo || "—"}</p>
      <hr/>
      <h3>Resultados da simulação</h3>
      <p><strong>Capital total financiado:</strong> ${capitalTotalFinanciado || "—"}</p>
      <p><strong>Nova prestação:</strong> ${novaPrestacao || "—"}</p>
      <p><strong>TAN:</strong> ${tan || "—"}</p>
      <p><strong>TAEG:</strong> ${taeg || "—"}</p>
      <p><strong>MTIC (custo total):</strong> ${mtic || "—"}</p>
      <p><strong>Variação da prestação mensal:</strong> ${variacaoPrestacaoMensal || "—"}</p>
    `;

    await brevo.sendTransacEmail({
      sender: REMETENTE,
      to: [{ email: LEADS_TO }],
      cc: [{ email: LEADS_CC }],
      subject: `Novo pedido Crédito Multiopções — ${nome}`,
      htmlContent: htmlInterno
    });

    const horarioTexto2 = horario && horario !== "Qualquer hora"
      ? `, preferencialmente <strong>${horario}</strong>`
      : "";

    const htmlCliente = `
      <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; color:#333;">
        <h2 style="color:#153A26;">Recebemos o seu pedido!</h2>
        <p>Olá <strong>${nome}</strong>,</p>
        <p>Obrigado pelo seu contacto. Recebemos a sua simulação de Crédito Multiopções e entraremos em contacto consigo em breve${horarioTexto2}.</p>
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <h3 style="color:#153A26;">Resumo da sua simulação</h3>
        <p><strong>Finalidade:</strong> ${finalidade || "—"}</p>
        <p><strong>Montante a libertar:</strong> ${montanteLibertar || "—"}</p>
        <p><strong>Prazo pretendido:</strong> ${novoPrazo || "—"}</p>
        ${htmlTaxa}
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <h3 style="color:#153A26;">Resultado indicativo</h3>
        <p><strong>Capital total financiado:</strong> ${capitalTotalFinanciado || "—"}</p>
        <p><strong>Nova prestação mensal:</strong> ${novaPrestacao || "—"}</p>
        <p><strong>Prestação atual:</strong> ${prestacaoAtual || "—"}</p>
        <p><strong>Variação da prestação mensal:</strong> ${variacaoPrestacaoMensal || "—"}</p>
        <p><strong>TAN:</strong> ${tan || "—"} &nbsp;|&nbsp; <strong>TAEG:</strong> ${taeg || "—"}</p>
        <p><strong>MTIC (custo total estimado):</strong> ${mtic || "—"}</p>
        <p><strong>Taxa de esforço antes:</strong> ${dstiAntes || "—"} &nbsp;→&nbsp; <strong>depois:</strong> ${dstiDepois || "—"}</p>
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <p style="font-size:12px; color:#999;">Valores meramente indicativos, sujeitos a análise e aprovação bancária.</p>
        <p style="font-size:13px;">Com os melhores cumprimentos,</p>${ASSINATURA}
      </div>
    `;

    await brevo.sendTransacEmail({
      sender: REMETENTE,
      to: [{ email: email, name: nome }],
      subject: `A sua simulação de Crédito Multiopções — ${MARCA}`,
      htmlContent: htmlCliente
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar email multiopções:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  NOVAS ROTAS — PORTAL DE CLIENTES
// ═══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// TRATAMENTO DE ERROS
// ─────────────────────────────────────────────
// Sem isto, o erro do CORS caía no handler por omissão do Express e devolvia
// um 500 em HTML, sem dizer o que se passava. Custou um diagnóstico longo
// quando a origem de um site ainda não estava na lista.
app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") {
    console.warn(`CORS: origem recusada "${req.headers.origin}" em ${req.method} ${req.path}`);
    return res.status(403).json({
      success: false,
      message: "Origem não autorizada. Se este pedido vem de um site da Bruma Finance ou da Fin+, é preciso acrescentar a origem à lista permitida no backend.",
    });
  }

  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ success: false, message: "Pedido demasiado grande." });
  }

  console.error("Erro não tratado:", err);
  res.status(500).json({ success: false, message: "Erro interno do servidor." });
});

// ─────────────────────────────────────────────
// SERVIDOR
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
