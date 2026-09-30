"""La suite no toca la base de datos real del usuario.

`conftest.py` redirige `DATABASE_PATH` a un directorio temporal antes de que se
importe nada de `app`. Si alguien reordena esos imports, el motor se construye
con la ruta real y la suite empieza a escribir —y, desde el RC1, a limpiar— en
`backend/data/app.db`. Este test es la alarma.
"""

from app.config import settings
from app.db.engine import engine


def test_la_suite_no_usa_la_base_de_datos_real():
    assert "app-tests-" in settings.database_path
    assert "app-tests-" in str(engine.url)
    assert "backend/data/app.db" not in str(engine.url)
