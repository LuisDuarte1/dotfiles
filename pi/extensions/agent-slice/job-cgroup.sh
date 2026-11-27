# Sourced through BASH_ENV by every non-interactive bash: one still in pi's own cgroup moves to a
# job cgroup of its own, so oomd kills that job and spares pi. Anywhere else it does nothing.
if [ -n "${PI_AGENT_CGROUP-}" ] && read -r _pi_cg < /proc/self/cgroup && [ "${_pi_cg#0::}" = "$PI_AGENT_CGROUP/main" ]; then
	_pi_job=/sys/fs/cgroup$PI_AGENT_CGROUP/job-$$-$EPOCHSECONDS
	mkdir "$_pi_job" 2>/dev/null && echo $$ 2>/dev/null > "$_pi_job/cgroup.procs"
fi
unset _pi_cg _pi_job
