// =====================================================
//  WEISX PRO - Servidor (contas, planos, PIX, cupons e painel ADM)
// =====================================================
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');

const {
  MONGODB_URI,          // link do banco MongoDB Atlas
  JWT_SECRET,           // uma senha grande e aleatória só sua
  MP_ACCESS_TOKEN,      // Access Token de PRODUÇÃO do Mercado Pago
  PUBLIC_URL,           // ex: https://weisx-pro-backend.onrender.com
  ADMIN_SENHA,          // senha do painel ADM (/admin)
  PORT = 3000,
} = process.env;

// ---------- PLANOS (mude os preços no Render, sem mexer no código) ----------
const PLANOS = {
  teste:  { nome: 'Teste 1 dia', dias: 1,  preco: Number(process.env.PRECO_TESTE ?? 0)  },
  dias15: { nome: '15 dias',     dias: 15, preco: Number(process.env.PRECO_15    ?? 15) },
  dias30: { nome: '30 dias',     dias: 30, preco: Number(process.env.PRECO_30    ?? 25) },
};

const DIA = 24 * 60 * 60 * 1000;
const ONLINE_MS = 7 * 60 * 1000; // conta como online se o app deu sinal nos últimos 7 min

// ---------- BANCO DE DADOS ----------
const Usuario = mongoose.model('Usuario', new mongoose.Schema({
  
  usuario:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  email:       { type: String, required: true, unique: true, lowercase: true, trim: true },
  senhaHash:   { type: String, required: true },
  acessoAte:   { type: Date, default: null },
  usouTeste:   { type: Boolean, default: false },
  ultimoPlano: { type: String, default: null },
  ultimoPing:  { type: Date, default: null },
  criadoEm:    { type: Date, default: Date.now },
}));

const Pagamento = mongoose.model('Pagamento', new mongoose.Schema({
  mpId:      { type: String, required: true, unique: true },
  usuarioId: { type: mongoose.Schema.Types.ObjectId, required: true },
  plano:     { type: String, required: true },
  valor:     Number,
  cupom:     { type: String, default: null },
  status:    { type: String, default: 'pending' },
  creditado: { type: Boolean, default: false },
  criadoEm:  { type: Date, default: Date.now },
}));

const Cupom = mongoose.model('Cupom', new mongoose.Schema({
  codigo:   { type: String, required: true, unique: true, uppercase: true, trim: true },
  desconto: { type: Number, required: true, min: 1, max: 100 }, // em %
  usosMax:  { type: Number, default: 0 },                         // 0 = ilimitado
  usos:     { type: Number, default: 0 },
  usadoPor: [{ type: mongoose.Schema.Types.ObjectId }],
  ativo:    { type: Boolean, default: true },
  criadoEm: { type: Date, default: Date.now },
}));

const Mensagem = mongoose.model('Mensagem', new mongoose.Schema({
  nome:     { type: String, required: true },
  contato:  { type: String, required: true },
  tipo:     { type: String, default: 'sugestao' },   // sugestao | bug | duvida | outro
  texto:    { type: String, required: true },
  lida:     { type: Boolean, default: false },
  criadoEm: { type: Date, default: Date.now },
}));

// ---------- FUNÇÕES ----------
function gerarToken(u) {
  // Token dura 1 ano e é renovado toda vez que o app abre = login "pra sempre"
  return jwt.sign({ id: u._id.toString() }, JWT_SECRET, { expiresIn: '365d' });
}

function estaOnline(u) {
  return !!u.ultimoPing && Date.now() - u.ultimoPing.getTime() < ONLINE_MS;
}

function resumo(u) {
  const agora = Date.now();
  const ativo = !!u.acessoAte && u.acessoAte.getTime() > agora;
  return {
    usuario: u.usuario,
    email: u.email,
    acessoAte: u.acessoAte,
    ativo,
    diasRestantes: ativo ? Math.ceil((u.acessoAte.getTime() - agora) / DIA) : 0,
    usouTeste: u.usouTeste,
  };
}

function nomePlano(id) {
  if (!id) return null;
  if (id === 'manual') return 'Liberado pelo ADM';
  return PLANOS[id] ? PLANOS[id].nome : id;
}

// Se ainda tem dias, soma em cima. Se venceu, conta a partir de agora.
function liberar(u, dias) {
  const base = u.acessoAte && u.acessoAte.getTime() > Date.now() ? u.acessoAte.getTime() : Date.now();
  u.acessoAte = new Date(base + dias * DIA);
}

async function buscarCupom(codigo, u) {
  if (!codigo) return { cupom: null };
  const c = await Cupom.findOne({ codigo: String(codigo).trim().toUpperCase() });
  if (!c || !c.ativo) return { erro: 'Cupom inválido.' };
  if (c.usosMax > 0 && c.usos >= c.usosMax) return { erro: 'Esse cupom já esgotou.' };
  if (c.usadoPor.some(id => id.equals(u._id))) return { erro: 'Você já usou esse cupom.' };
  return { cupom: c };
}

function precoComCupom(preco, cupom) {
  if (!cupom) return preco;
  return Math.round(preco * (100 - cupom.desconto)) / 100;
}

async function marcarCupom(codigo, usuarioId) {
  if (!codigo) return;
  await Cupom.updateOne({ codigo }, { $inc: { usos: 1 }, $addToSet: { usadoPor: usuarioId } });
}

// Pega erros das rotas pra o servidor não cair
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { id } = jwt.verify(token, JWT_SECRET);
    if (!id) throw new Error();
    req.user = await Usuario.findById(id);
    if (!req.user) throw new Error();
    next();
  } catch {
    res.status(401).json({ erro: 'Sessão expirada. Faça login de novo.' });
  }
}

function admin(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const p = jwt.verify(token, JWT_SECRET);
    if (!p.admin) throw new Error();
    next();
  } catch {
    res.status(401).json({ erro: 'Acesso negado.' });
  }
}

async function verificarPagamento(mpId) {
  const pag = await Pagamento.findOne({ mpId: String(mpId) });
  if (!pag || pag.creditado) return pag;

  const r = await fetch(`https://api.mercadopago.com/v1/payments/${mpId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  if (!r.ok) return pag;
  const mp = await r.json();
  pag.status = mp.status;

  if (mp.status === 'approved') {
    // Trava pra nunca creditar o mesmo pagamento 2 vezes
    const travado = await Pagamento.findOneAndUpdate(
      { mpId: pag.mpId, creditado: false },
      { creditado: true, status: 'approved' },
      { new: true }
    );
    if (travado) {
      const u = await Usuario.findById(pag.usuarioId);
      if (u) {
        liberar(u, PLANOS[pag.plano].dias);
        u.ultimoPlano = pag.plano;
        if (pag.plano === 'teste') u.usouTeste = true;
        await u.save();
        await marcarCupom(pag.cupom, u._id);
      }
      return travado;
    }
  } else {
    await pag.save();
  }
  return pag;
}

// ---------- ROTAS DO APP ----------
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// ---------- SITE ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'site.html')));
app.get('/weisx.png', (req, res) => res.sendFile(path.join(__dirname, 'weisx.png')));
app.get('/status', (req, res) => res.send('WEISX PRO online'));

// Botão "Baixar": leva pro link do instalador (variável DOWNLOAD_URL no Render)
app.get('/download', (req, res) => {
  const url = process.env.DOWNLOAD_URL;
  if (url && /^https:\/\//.test(url)) return res.redirect(url);
  res.status(200).send('<meta charset="utf-8"><body style="background:#090507;color:#f5eef0;font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><div><h2>Download disponível em breve</h2><p><a href="/" style="color:#ef3b3b">Voltar ao site</a></p></div>');
});

// Formulário de contato do site (bloqueia spam: 5 mensagens por hora por pessoa)
const envios = new Map();
const TIPOS = ['sugestao', 'bug', 'duvida', 'outro'];
app.post('/contato', h(async (req, res) => {
  if (req.body.site) return res.json({ ok: true }); // robô preencheu o campo escondido
  const agora = Date.now();
  const lista = (envios.get(req.ip) || []).filter(t => agora - t < 60 * 60 * 1000);
  if (lista.length >= 5) return res.status(429).json({ erro: 'Você já mandou várias mensagens. Tente de novo daqui a pouco.' });

  const nome = String(req.body.nome || '').trim().slice(0, 40);
  const contato = String(req.body.contato || '').trim().slice(0, 80);
  const texto = String(req.body.texto || '').trim().slice(0, 1000);
  const tipo = TIPOS.includes(req.body.tipo) ? req.body.tipo : 'outro';
  if (!nome || !contato) return res.status(400).json({ erro: 'Coloque seu nome e um Discord ou e-mail.' });
  if (texto.length < 5) return res.status(400).json({ erro: 'Escreva um pouco mais na mensagem.' });

  await Mensagem.create({ nome, contato, tipo, texto });
  lista.push(agora);
  envios.set(req.ip, lista);
  res.json({ ok: true });
}));

app.post('/cadastro', h(async (req, res) => {
  const usuario = String(req.body.usuario || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');

  if (!/^[a-z0-9_.]{3,20}$/.test(usuario))
    return res.status(400).json({ erro: 'Usuário: 3 a 20 letras/números, sem espaço.' });
  if (!/^\S+@\S+\.\S+$/.test(email))
    return res.status(400).json({ erro: 'E-mail inválido.' });
  if (senha.length < 6)
    return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });

  if (await Usuario.findOne({ usuario })) return res.status(409).json({ erro: 'Esse usuário já existe.' });
  if (await Usuario.findOne({ email }))   return res.status(409).json({ erro: 'Esse e-mail já tem conta.' });

  const u = await Usuario.create({
    usuario, email, senhaHash: await bcrypt.hash(senha, 10), ultimoPing: new Date(),
  });
  res.json({ token: gerarToken(u), conta: resumo(u) });
}));

app.post('/login', h(async (req, res) => {
  const usuario = String(req.body.usuario || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');
  const u = await Usuario.findOne({ $or: [{ usuario }, { email: usuario }] });
  if (!u || !(await bcrypt.compare(senha, u.senhaHash)))
    return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
  u.ultimoPing = new Date();
  await u.save();
  res.json({ token: gerarToken(u), conta: resumo(u) });
}));

// O app chama isso ao abrir e a cada 5 minutos (serve pra saber quem está online)
app.get('/me', auth, h(async (req, res) => {
  req.user.ultimoPing = new Date();
  await req.user.save();
  res.json({ token: gerarToken(req.user), conta: resumo(req.user) });
}));

// App fechou ou saiu da conta
app.post('/offline', auth, h(async (req, res) => {
  req.user.ultimoPing = null;
  await req.user.save();
  res.json({ ok: true });
}));

app.get('/planos', (req, res) => {
  res.json({ planos: Object.entries(PLANOS).map(([id, p]) => ({ id, ...p })) });
});

app.get('/cupom/:codigo', auth, h(async (req, res) => {
  const { cupom, erro } = await buscarCupom(req.params.codigo, req.user);
  if (erro) return res.status(400).json({ erro });
  res.json({ codigo: cupom.codigo, desconto: cupom.desconto });
}));

app.post('/comprar', auth, h(async (req, res) => {
  const plano = String(req.body.plano || '');
  const p = PLANOS[plano];
  if (!p) return res.status(400).json({ erro: 'Plano inválido.' });
  if (plano === 'teste' && req.user.usouTeste)
    return res.status(400).json({ erro: 'Você já usou o plano de 1 dia.' });

  const { cupom, erro } = await buscarCupom(req.body.cupom, req.user);
  if (erro) return res.status(400).json({ erro });
  const valor = precoComCupom(p.preco, cupom);

  // Grátis (preço 0 ou cupom de 100%): libera na hora
  if (valor <= 0) {
    liberar(req.user, p.dias);
    req.user.ultimoPlano = plano;
    if (plano === 'teste') req.user.usouTeste = true;
    await req.user.save();
    if (cupom) await marcarCupom(cupom.codigo, req.user._id);
    return res.json({ liberado: true, conta: resumo(req.user) });
  }

  // Pago: gera PIX no Mercado Pago
  const r = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      transaction_amount: valor,
      description: `WEISX PRO - ${p.nome}`,
      payment_method_id: 'pix',
      payer: { email: req.user.email },
      notification_url: `${PUBLIC_URL}/webhook/mercadopago`,
      external_reference: `${req.user._id}:${plano}`,
    }),
  });
  const mp = await r.json();
  if (!r.ok) {
    console.error('Erro Mercado Pago:', mp);
    return res.status(500).json({ erro: 'Não foi possível gerar o PIX. Tente de novo.' });
  }

  await Pagamento.create({
    mpId: String(mp.id), usuarioId: req.user._id, plano, valor,
    cupom: cupom ? cupom.codigo : null, status: mp.status,
  });

  const pix = mp.point_of_interaction.transaction_data;
  res.json({
    pagamentoId: String(mp.id),
    valor,
    qrCode: pix.qr_code,
    qrCodeBase64: pix.qr_code_base64,
  });
}));

app.get('/pagamento/:id', auth, h(async (req, res) => {
  const pag = await Pagamento.findOne({ mpId: req.params.id, usuarioId: req.user._id });
  if (!pag) return res.status(404).json({ erro: 'Pagamento não encontrado.' });
  const atual = await verificarPagamento(pag.mpId);
  const u = await Usuario.findById(req.user._id);
  res.json({ status: atual.status, conta: resumo(u) });
}));

// Mercado Pago avisa aqui quando o PIX é pago
app.post('/webhook/mercadopago', (req, res) => {
  res.sendStatus(200);
  const id = req.query['data.id'] || req.body?.data?.id || req.query.id;
  if (id) verificarPagamento(id).catch(e => console.error('Webhook:', e));
});

// ---------- PAINEL ADM ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Bloqueia quem errar a senha 5 vezes por 15 minutos
const tentativas = new Map();
app.post('/admin/login', (req, res) => {
  const ip = req.ip;
  const t = tentativas.get(ip) || { n: 0, ate: 0 };
  if (t.ate > Date.now()) return res.status(429).json({ erro: 'Muitas tentativas. Espere 15 minutos.' });

  const senha = Buffer.from(String(req.body.senha || ''));
  const certa = Buffer.from(String(ADMIN_SENHA || ''));
  const ok = certa.length > 0 && senha.length === certa.length && crypto.timingSafeEqual(senha, certa);
  if (!ok) {
    t.n++;
    if (t.n >= 5) { t.n = 0; t.ate = Date.now() + 15 * 60 * 1000; }
    tentativas.set(ip, t);
    return res.status(401).json({ erro: 'Senha incorreta.' });
  }
  tentativas.delete(ip);
  res.json({ token: jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '30d' }) });
});

app.get('/admin/resumo', admin, h(async (req, res) => {
  const agora = new Date();
  const [total, ativos, online, fat, novas] = await Promise.all([
    Usuario.countDocuments(),
    Usuario.countDocuments({ acessoAte: { $gt: agora } }),
    Usuario.countDocuments({ ultimoPing: { $gt: new Date(Date.now() - ONLINE_MS) } }),
    Pagamento.aggregate([{ $match: { creditado: true } }, { $group: { _id: null, total: { $sum: '$valor' } } }]),
    Mensagem.countDocuments({ lida: false }),
  ]);
  res.json({ total, ativos, online, faturamento: fat[0] ? fat[0].total : 0, mensagensNovas: novas });
}));

app.get('/admin/usuarios', admin, h(async (req, res) => {
  const lista = await Usuario.find().sort({ criadoEm: -1 }).limit(2000);
  res.json({
    usuarios: lista.map(u => ({
      id: u._id,
      ...resumo(u),
      plano: nomePlano(u.ultimoPlano),
      online: estaOnline(u),
      ultimoPing: u.ultimoPing,
      criadoEm: u.criadoEm,
    })),
  });
}));

// Dar (número positivo) ou tirar (número negativo) dias de alguém
app.post('/admin/usuarios/:id/dias', admin, h(async (req, res) => {
  const dias = parseInt(req.body.dias, 10);
  if (!dias || Math.abs(dias) > 3650) return res.status(400).json({ erro: 'Quantidade de dias inválida.' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ erro: 'Conta não encontrada.' });
  const u = await Usuario.findById(req.params.id);
  if (!u) return res.status(404).json({ erro: 'Conta não encontrada.' });

  if (dias > 0) {
    liberar(u, dias);
    if (!u.ultimoPlano) u.ultimoPlano = 'manual';
  } else if (u.acessoAte) {
    u.acessoAte = new Date(u.acessoAte.getTime() + dias * DIA);
  }
  await u.save();
  res.json({ conta: resumo(u) });
}));

app.get('/admin/cupons', admin, h(async (req, res) => {
  const lista = await Cupom.find().sort({ criadoEm: -1 });
  res.json({
    cupons: lista.map(c => ({
      id: c._id, codigo: c.codigo, desconto: c.desconto,
      usosMax: c.usosMax, usos: c.usos, ativo: c.ativo, criadoEm: c.criadoEm,
    })),
  });
}));

app.post('/admin/cupons', admin, h(async (req, res) => {
  const codigo = String(req.body.codigo || '').trim().toUpperCase();
  const desconto = parseInt(req.body.desconto, 10);
  const usosMax = parseInt(req.body.usosMax, 10) || 0;
  if (!/^[A-Z0-9_-]{3,20}$/.test(codigo))
    return res.status(400).json({ erro: 'Código: 3 a 20 letras/números, sem espaço.' });
  if (!(desconto >= 1 && desconto <= 100))
    return res.status(400).json({ erro: 'Desconto tem que ser de 1 a 100%.' });
  if (usosMax < 0) return res.status(400).json({ erro: 'Limite de usos inválido.' });
  if (await Cupom.findOne({ codigo })) return res.status(409).json({ erro: 'Esse cupom já existe.' });
  await Cupom.create({ codigo, desconto, usosMax });
  res.json({ ok: true });
}));

app.patch('/admin/cupons/:id', admin, h(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ erro: 'Cupom não encontrado.' });
  await Cupom.updateOne({ _id: req.params.id }, { ativo: !!req.body.ativo });
  res.json({ ok: true });
}));

app.delete('/admin/cupons/:id', admin, h(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ erro: 'Cupom não encontrado.' });
  await Cupom.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

// Mensagens do contato
app.get('/admin/mensagens', admin, h(async (req, res) => {
  const lista = await Mensagem.find().sort({ criadoEm: -1 }).limit(500);
  res.json({ mensagens: lista.map(m => ({
    id: m._id, nome: m.nome, contato: m.contato, tipo: m.tipo, texto: m.texto, lida: m.lida, criadoEm: m.criadoEm,
  })) });
}));

app.patch('/admin/mensagens/:id', admin, h(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ erro: 'Mensagem não encontrada.' });
  await Mensagem.updateOne({ _id: req.params.id }, { lida: !!req.body.lida });
  res.json({ ok: true });
}));

app.delete('/admin/mensagens/:id', admin, h(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ erro: 'Mensagem não encontrada.' });
  await Mensagem.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

// ---------- ERROS ----------
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  res.status(500).json({ erro: 'Erro no servidor. Tente de novo.' });
});
process.on('unhandledRejection', e => console.error('Erro não tratado:', e));

// ---------- INICIAR ----------
mongoose.connect(MONGODB_URI)
  .then(() => app.listen(PORT, () => console.log('WEISX PRO rodando na porta', PORT)))
  .catch(e => { console.error('Erro ao conectar no banco:', e); process.exit(1); });
