# Avaliação do Workshop — VozUP

Pesquisa de satisfação respondida pelos participantes **no fim do Workshop de
Oratória da VozUP**. São três perguntas, em quatro etapas, com identificação
(nome + WhatsApp) na primeira.

Página estática + uma função serverless na Vercel, no mesmo formato dos outros
formulários do grupo (`instituto-up-formulario`, `aula-experimental`).

## As três perguntas

1. **De 0 a 10**, quanto este workshop contribuiu para você perceber algo que
   precisa desenvolver na sua comunicação? (`nota_contribuicao`, 0 a 10)
2. **Qual momento do workshop mais contribuiu para a sua experiência?**
   (`momento_marcante`, 5 opções)
3. **Qual será seu próximo passo com a VozUP?** (`interesse_continuar`,
   4 opções: consultoria individual, plano ideal, "entrem em contato" e
   *"Não tenho interesse em continuar neste momento"*)

Quem pede algum próximo passo — ou seja, qualquer resposta menos *"Não tenho
interesse em continuar neste momento"* — vê, na tela de obrigado, um botão que
abre o WhatsApp da escola já com a mensagem escrita, dizendo qual passo foi.

## Isto NÃO cadastra lead

As respostas vão para a tabela **`inscricoes.avaliacoes_workshop`**, separada de
`inscricoes.inscricoes`. Quem responde já participou do workshop — não é lead
novo. Gravar avaliação como inscrição inflaria a contagem de leads, criaria
bloco fantasma no `/vozup` e jogaria gente na Chegada de Leads (ver
`docs/cartilha-formularios-produtos.md` na raiz do monorepo, regras 1, 2 e 6).

Para cruzar avaliação com lead, use o telefone: o payload guarda
`telefone_digits` já normalizado (11 dígitos, sem DDI).

## Configuração na Vercel

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DATABASE_URL` | **sim** | Postgres onde a tabela vive (o mesmo dos outros formulários) |
| `PG_SSL` | **na prática, sim** | `disable`. O Postgres do projeto (`postgres:16-alpine`) sobe **sem TLS**: sem isso o driver tenta SSL, o servidor recusa e nada é gravado. Alternativa equivalente: `?sslmode=disable` no fim da `DATABASE_URL` |
| `ALLOWED_ORIGINS` | não | Origens extras autorizadas a chamar a API (a do próprio domínio já é aceita) |

Se algo der errado, a API responde **dizendo o que arrumar** (TLS, senha recusada,
banco inexistente) junto com o código do Postgres — não existe 500 mudo aqui.

A tabela é criada sozinha no primeiro envio (`CREATE TABLE IF NOT EXISTS`).

## Trocar a data do workshop

A data fica em `WORKSHOP_CONFIG` no topo do `<script>` do `index.html`:

```js
const WORKSHOP_CONFIG = { dateISO: '2026-09-17' };
```

Ela vira o rótulo `Workshop DD/MM/AAAA`, que aparece na página e é gravado em
`workshop_rotulo` — mesma convenção de rótulo das páginas de workshop em
`aula-experimental/`.

**Sem alterar código:** o mesmo link atende outra data com `?data=` na URL —
`?data=2026-09-24` ou `?data=24/09/2026`. Útil para não precisar de um deploy por
turma. Se a URL não trouxer nada, vale a constante.

## Ler as respostas

```sql
-- Uma linha por avaliação
SELECT id,
       criado_em,
       payload->>'workshop_rotulo'              AS workshop,
       payload->>'nome'                         AS nome,
       payload->>'telefone'                     AS telefone,
       (payload->>'nota_contribuicao')::int     AS nota,
       payload->>'momento_marcante'             AS momento,
       payload->>'interesse_continuar'          AS interesse
  FROM inscricoes.avaliacoes_workshop
 ORDER BY criado_em DESC;

-- Média por workshop e quantos querem próximos passos
SELECT payload->>'workshop_rotulo' AS workshop,
       COUNT(*)                                                   AS respostas,
       ROUND(AVG((payload->>'nota_contribuicao')::int), 1)        AS nota_media,
       COUNT(*) FILTER (
         WHERE payload->>'interesse_continuar' <> 'Não tenho interesse em continuar neste momento'
       )                                                          AS quer_proximos_passos
  FROM inscricoes.avaliacoes_workshop
 GROUP BY 1
 ORDER BY 1;
```

## Rodar local

```bash
npm install          # só o driver pg, usado pela função serverless
npm run dev          # http://localhost:5173 (página estática)
npm test             # testa api/avaliacao.js com Postgres simulado
```

O `dev-server.js` serve só os arquivos estáticos — ele não executa a pasta
`api/`. Para testar o envio de ponta a ponta, use `vercel dev` ou um deploy de
preview.

## Regras que o servidor garante

`api/avaliacao.js` não confia no navegador:

- as respostas das perguntas 2 e 3 têm **lista fechada** conferida no servidor;
- a nota precisa ser inteiro de 0 a 10 — **0 é resposta válida**, não "campo vazio";
- telefone precisa ter 10 ou 11 dígitos;
- **uma avaliação por pessoa por workshop**: reenvio da mesma aba (`clientId`) ou
  mesmo telefone no mesmo workshop devolve `deduped: true` em vez de gravar de
  novo — média de nota não pode torcer por causa de um F5.

## Deploy

Grupo B do `docs/deploy-map.md`: hospedado na **Vercel**, conectado ao repositório
`hduquinha/avaliacao-workshop` no GitHub. Sem `git push`, a mudança não vai ao ar.
