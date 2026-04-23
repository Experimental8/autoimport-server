# AutoImport Server

Servidor de sincronização automática para a plataforma AutoImport.

## Funcionalidades
- Sincroniza análises de hora em hora via Apify
- Detecta novos anúncios e envia notificações push via ntfy.sh
- API REST simples para a plataforma HTML comunicar

## Setup

### 1. Variáveis de ambiente (Railway)
```
APIFY_TOKEN=apify_api_xxxxx
PORT=3000
```

### 2. Deploy no Railway
1. Faz push deste repositório para o GitHub
2. Vai a railway.app → New Project → Deploy from GitHub
3. Selecciona o repositório
4. Adiciona as variáveis de ambiente acima
5. Deploy automático

### 3. Notificações (ntfy.sh)
1. Instala a app **ntfy** no telemóvel (iOS/Android) — gratuito
2. Subscreve o canal que configurares na análise (ex: `autoimport_jose`)
3. Recebes notificações push quando aparecem novos anúncios

## API

| Método | Path | Descrição |
|--------|------|-----------|
| GET | /health | Estado do servidor |
| GET | /analyses | Listar análises com sync activo |
| POST | /analyses | Criar/actualizar análise |
| DELETE | /analyses/:id | Remover análise |
| POST | /sync | Forçar sync manual |

## Exemplo de análise
```json
{
  "id": 1234567890,
  "name": "Porsche 911 2020+",
  "syncEnabled": true,
  "minScore": 7,
  "ntfyChannel": "autoimport_jose",
  "searchUrls": [
    { "url": "https://www.autoscout24.com/lst/porsche/991?...", "source": "as24" },
    { "url": "https://suchen.mobile.de/fahrzeuge/search.html?ms=20100;;40;...", "source": "mde" }
  ]
}
```
