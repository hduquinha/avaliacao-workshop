// Testa api/avaliacao.js com o Postgres SIMULADO (o driver `pg` nem precisa
// estar instalado). O que esta em jogo: a media da nota e a leitura das
// respostas. Nota 0 tem que ser aceita (e a critica mais valiosa), resposta
// fora da lista fechada tem que ser recusada, e reenvio nao pode virar
// segunda linha na tabela.
const assert = require('assert');
const path = require('path');
const Module = require('module');

const RAIZ = path.join(__dirname, '..');

process.env.DATABASE_URL = 'postgresql://teste:teste@localhost:5432/teste';

let linhas = [];
let sqlsInesperados = [];

const poolFalso = {
  on(){ /* o handler registra um listener de erro no pool */ },
  async connect(){
    return { query: async () => ({ rows: [], rowCount: 0 }), release(){} };
  },
  async query(sql, params){
    const texto = String(sql).trim();

    if(/^SELECT id FROM inscricoes\.avaliacoes_workshop/.test(texto)){
      const achadas = /clientId/.test(texto)
        ? linhas.filter((l)=> l.payload.clientId === params[0])
        : linhas.filter((l)=> l.payload.telefone_digits === params[0] && l.payload.workshop_rotulo === params[1]);
      return { rows: achadas.map((l)=> ({ id: l.id })), rowCount: achadas.length };
    }

    if(/^INSERT INTO inscricoes\.avaliacoes_workshop/.test(texto)){
      const id = linhas.length + 1;
      linhas.push({ id, payload: params[0] });
      return { rows: [{ id }], rowCount: 1 };
    }

    sqlsInesperados.push(texto);
    throw new Error('SQL inesperado no teste: ' + texto);
  },
};

const carregarModuloOriginal = Module._load;
Module._load = function (request) {
  if (request === 'pg') return { Pool: function FakePool(){ return poolFalso; } };
  return carregarModuloOriginal.apply(this, arguments);
};

const avaliacao = require(path.join(RAIZ, 'api/avaliacao.js'));

function respostaFalsa(){
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(nome, valor){ this.headers[nome.toLowerCase()] = valor; },
    getHeader(nome){ return this.headers[nome.toLowerCase()]; },
    status(codigo){ this.statusCode = codigo; return this; },
    json(corpo){ this.body = corpo; return this; },
    end(){ return this; },
  };
  return res;
}

async function enviar(body, method = 'POST'){
  const res = respostaFalsa();
  await avaliacao({ method, headers: { host: 'avaliacao.test' }, body }, res);
  return res;
}

const RESPOSTA_VALIDA = {
  nome: 'Maria Souza',
  telefone: '(11) 98888-7777',
  nota_contribuicao: '9',
  momento_marcante: 'Storytelling (a forma estratégica para gerar conexão)',
  interesse_continuar: 'Quero agendar minha consultoria individual para conhecer a grade de cursos',
  workshop_rotulo: 'Workshop 17/09/2026',
  workshop_data: '2026-09-17',
  clientId: 'aba-1',
  page: 'https://avaliacao.test/',
};

async function main(){
  // Caminho feliz: grava e devolve o id.
  let res = await enviar(RESPOSTA_VALIDA);
  assert.strictEqual(res.statusCode, 200, 'resposta valida deveria ser aceita');
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.avaliacaoId, 1);
  assert.strictEqual(linhas[0].payload.nota_contribuicao, 9, 'nota deve ir como numero');
  assert.strictEqual(linhas[0].payload.telefone_digits, '11988887777');

  // Reenvio da mesma aba nao cria segunda linha.
  res = await enviar(RESPOSTA_VALIDA);
  assert.strictEqual(res.body.deduped, true, 'reenvio deveria ser deduplicado');
  assert.strictEqual(linhas.length, 1, 'reenvio nao pode gravar de novo');

  // Mesmo telefone, mesmo workshop, outra aba: continua sendo uma avaliacao.
  res = await enviar({ ...RESPOSTA_VALIDA, clientId: 'aba-2' });
  assert.strictEqual(res.body.deduped, true, 'mesmo telefone no mesmo workshop deveria deduplicar');
  assert.strictEqual(linhas.length, 1);

  // Outro workshop: e uma avaliacao nova, mesmo telefone.
  res = await enviar({
    ...RESPOSTA_VALIDA,
    clientId: 'aba-3',
    workshop_rotulo: 'Workshop 24/09/2026',
    workshop_data: '2026-09-24',
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.deduped, undefined, 'workshop diferente e avaliacao nova');
  assert.strictEqual(linhas.length, 2);

  // Nota 0 e resposta valida — nunca pode cair como "campo vazio".
  res = await enviar({ ...RESPOSTA_VALIDA, clientId: 'aba-4', telefone: '(11) 97777-6666', nota_contribuicao: '0' });
  assert.strictEqual(res.statusCode, 200, 'nota 0 deveria ser aceita');
  assert.strictEqual(linhas[2].payload.nota_contribuicao, 0);

  // Fora da escala, sem nota e opcao inventada: recusados.
  for (const invalido of [
    { nota_contribuicao: '11' },
    { nota_contribuicao: '' },
    { momento_marcante: 'Coffee break' },
    { interesse_continuar: 'Vou comprar agora' },
    { nome: 'M' },
    { telefone: '119' },
  ]) {
    const chave = Object.keys(invalido)[0];
    res = await enviar({ ...RESPOSTA_VALIDA, clientId: 'invalido-' + chave, ...invalido });
    assert.strictEqual(res.statusCode, 422, `${chave} invalido deveria ser recusado`);
    assert.strictEqual(res.body.ok, false);
  }
  assert.strictEqual(linhas.length, 3, 'nenhuma resposta invalida pode ter sido gravada');

  // Metodo errado nao chega no banco.
  res = await enviar(RESPOSTA_VALIDA, 'GET');
  assert.strictEqual(res.statusCode, 405);

  // Origem de fora nao e aceita (a pagina e publica, o POST nao pode ser).
  const resCors = respostaFalsa();
  await avaliacao(
    { method: 'POST', headers: { host: 'avaliacao.test', origin: 'https://site-aleatorio.test' }, body: RESPOSTA_VALIDA },
    resCors
  );
  assert.strictEqual(resCors.statusCode, 403, 'origem estranha deveria ser recusada');

  assert.deepStrictEqual(sqlsInesperados, [], 'o handler rodou SQL fora do esperado');

  // As listas exportadas sao as que a tela mostra.
  assert.strictEqual(avaliacao.MOMENTOS.length, 5);
  assert.strictEqual(avaliacao.INTERESSES.length, 4);

  console.log('ok — avaliacao.test.js');
}

main().catch((err)=>{
  console.error(err);
  process.exit(1);
});
