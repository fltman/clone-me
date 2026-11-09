#!/bin/zsh
# Läser nycklarna ur ~/.zprofile (de är inte exporterade där) och startar servern.
source ~/.zprofile >/dev/null 2>&1
export ELEVENLABS_API_KEY ANTHROPIC_API_KEY
cd "${0:A:h}"
exec node "${@:-server.mjs}"
