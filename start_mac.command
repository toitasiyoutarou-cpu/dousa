#!/bin/bash
cd "$(dirname "$0")"
python3 -m http.server 8000 &
open http://localhost:8000
wait
