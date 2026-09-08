# Recupera+ · Acompanhamento Pós-Cirúrgico
App full-stack (Express + SQLite). Subir ao GitHub e ligar ao Render.

## Estrutura
- server.js  → servidor
- public/    → frontend (SPA, PWA)
- render.yaml → config de deploy Render

## Deploy no Render
1. Criar repositório no GitHub e subir estes ficheiros
2. No Render: New → Web Service → ligar o repositório
3. Build: npm install | Start: node server.js
4. Definir variáveis (ver .env.example)
