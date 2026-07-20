process.stderr.write("dying before cleanup\n");
process.kill(process.pid, "SIGKILL");
