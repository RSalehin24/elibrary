#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
import sys

from watchfiles import PythonFilter, run_process


def build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(
    description="Restart a long-running command whenever Python files change.",
  )
  parser.add_argument(
    "--watch-dir",
    action="append",
    dest="watch_dirs",
    default=[],
    help="Directory to watch for Python file changes.",
  )
  parser.add_argument(
    "--cwd",
    default=os.getcwd(),
    help="Working directory for the managed command.",
  )
  parser.add_argument(
    "command",
    nargs=argparse.REMAINDER,
    help="Command to run after `--`.",
  )
  return parser


def main() -> int:
  parser = build_parser()
  args = parser.parse_args()
  command = list(args.command)
  if command and command[0] == "--":
    command = command[1:]

  if not command:
    parser.error("A command is required after --.")

  watch_dirs = args.watch_dirs or [args.cwd]

  def run_command() -> int:
    completed = subprocess.run(command, cwd=args.cwd, check=False)
    return completed.returncode

  run_process(
    *watch_dirs,
    target=run_command,
    watch_filter=PythonFilter(),
  )
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
