- [X] Afficher bar de temps avec un max de 10 sec et apres 10 sec le vote se termine automatiquement
- [X] Revoir le calcul de classement, valeur actuel:
  - 1er: 100
  - 2eme: 50
  - 3eme: 25
  - 4eme: 12.5


- [ ] fix error

damien@PC05:~/code/perso/blindtest$ uv run app.py
/home/damien/code/perso/blindtest/app.py:1: DeprecationWarning:
Eventlet is deprecated. It is currently being maintained in bugfix mode, and
we strongly recommend against using it for new projects.

If you are already using Eventlet, we recommend migrating to a different
framework.  For more detail see
https://eventlet.readthedocs.io/en/latest/asyncio/migration.html

  import eventlet
2026-04-05 12:09:16,443 - werkzeug - INFO -  * Restarting with stat
/home/damien/code/perso/blindtest/app.py:1: DeprecationWarning:
Eventlet is deprecated. It is currently being maintained in bugfix mode, and
we strongly recommend against using it for new projects.

If you are already using Eventlet, we recommend migrating to a different
framework.  For more detail see
https://eventlet.readthedocs.io/en/latest/asyncio/migration.html

  import eventlet
2026-04-05 12:09:17,300 - werkzeug - WARNING -  * Debugger is active!
2026-04-05 12:09:17,302 - werkzeug - INFO -  * Debugger PIN: 694-085-309
(9899) wsgi starting up on http://0.0.0.0:8000

- [ ] replace the start game with a modal
- [X] fix the unique id for the leaderboard

- [ ] when we disconnect from the device in connect we have to stop the song