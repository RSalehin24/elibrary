from pathlib import Path

from automation.lib.env_tools import render_compose_env


def test_render_compose_env_quotes_values_for_literal_compose_use(tmp_path):
    source_path = tmp_path / ".env"
    output_path = tmp_path / ".compose.env"
    source_path.write_text(
        "\n".join(
            [
                "# comment",
                "DJANGO_SECRET_KEY=abc$g8$r",
                "BACKEND_PORT=8000",
                "EMPTY_VALUE=",
                "ALREADY_QUOTED='leave-me-alone'",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    render_compose_env(source_path, output_path)

    assert output_path.read_text(encoding="utf-8") == "\n".join(
        [
            "# comment",
            "DJANGO_SECRET_KEY='abc$g8$r'",
            "BACKEND_PORT='8000'",
            "EMPTY_VALUE=",
            "ALREADY_QUOTED='leave-me-alone'",
            "",
        ]
    )


def test_render_compose_env_escapes_single_quotes(tmp_path):
    source_path = tmp_path / ".env"
    output_path = tmp_path / ".compose.env"
    source_path.write_text("SECRET=it's-private\n", encoding="utf-8")

    render_compose_env(source_path, output_path)

    assert output_path.read_text(encoding="utf-8") == "SECRET='it\\'s-private'\n"
