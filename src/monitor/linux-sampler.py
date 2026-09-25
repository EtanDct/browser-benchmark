"""Samples memory/CPU of a Linux process tree: on Linux hosts, and inside WSL for browsers hosted there.

Same line protocol as the Windows sampler: a root PID on stdin starts tracking its tree,
"0" pauses, EOF exits; one JSON line per tick. Memory is USS (Private_Clean + Private_Dirty
from smaps_rollup), the Linux counterpart of the Windows private working set: summing RSS over a
multi-process browser would count its shared libraries once per process.
"""
import json
import os
import select
import sys
import time

interval = int(sys.argv[1]) / 1000.0
clock_ticks = os.sysconf("SC_CLK_TCK")


def process_table():
    table = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % entry) as f:
                stat = f.read()
        except OSError:
            continue
        # comm can contain spaces and parentheses: fields start after the last ")".
        fields = stat[stat.rfind(")") + 2:].split()
        table[int(entry)] = (int(fields[1]), int(fields[11]) + int(fields[12]))
    return table


def private_bytes(pid):
    total = 0
    try:
        with open("/proc/%d/smaps_rollup" % pid) as f:
            for line in f:
                if line.startswith("Private_Clean:") or line.startswith("Private_Dirty:"):
                    total += int(line.split()[1]) * 1024
    except OSError:
        pass
    return total


def read_command(timeout):
    ready, _, _ = select.select([sys.stdin], [], [], timeout)
    if not ready:
        return None
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return line.strip()


root = 0
prev_cpu = {}
prev_time = None
print("READY", flush=True)

while True:
    if root <= 0:
        command = read_command(0.05)
        if command is not None and command.lstrip("-").isdigit():
            root, prev_cpu, prev_time = int(command), {}, None
        continue

    tick_start = time.monotonic()
    table = process_table()
    children = {}
    for pid, (ppid, _) in table.items():
        children.setdefault(ppid, []).append(pid)

    baseline = prev_time is None
    now = time.monotonic()
    mem, cpu_ticks, count, cur_cpu = 0, 0, 0, {}
    stack = [root] if root in table else []
    while stack:
        pid = stack.pop()
        if pid in cur_cpu:
            continue
        ticks = table[pid][1]
        cur_cpu[pid] = ticks
        count += 1
        mem += private_bytes(pid)
        if pid in prev_cpu:
            cpu_ticks += ticks - prev_cpu[pid]
        elif not baseline:
            cpu_ticks += ticks
        stack.extend(children.get(pid, []))

    cpu = None if baseline else round(cpu_ticks / clock_ticks / (now - prev_time) * 100, 2)
    prev_cpu, prev_time = cur_cpu, now
    print(json.dumps({"root": root, "t": int(time.time() * 1000), "mem": mem, "cpu": cpu, "n": count}), flush=True)

    command = read_command(max(0.0, interval - (time.monotonic() - tick_start)))
    if command is not None and command.lstrip("-").isdigit():
        root, prev_cpu, prev_time = int(command), {}, None
