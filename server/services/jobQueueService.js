import { isoNow } from "../utils/values.js";
import { isPostgresStorage, listKnownUsers, newId, postgresQuery, readJobs, writeJobs } from "../store/userDataStore.js";

export function addJob(userId, { type, payload = {}, status = "queued",maxAttempts = 5 } = {}) {
  const job = {
    id: newId("job"),
    type: type || "general",
    payload,
    status,
    attempts:0,
    maxAttempts:Math.max(1, Number(maxAttempts) || 5),
    runAfter:isoNow(),
    createdAt: isoNow(),
    updatedAt: isoNow(),
    startedAt: null,
    completedAt: null,
    error: "",
    result: null
  };
  const jobs = readJobs(userId);
  jobs.unshift(job);
  writeJobs(userId, jobs.slice(0, 500));
  return job;
}

export function listJobs(userId, { limit = 50, status = "all" } = {}) {
  const jobs = readJobs(userId);
  const filtered = status === "all" ? jobs : jobs.filter((job) => job.status === status);
  return filtered.slice(0, limit);
}

export function getJob(userId, jobId) {
  return readJobs(userId).find((job) => job.id === jobId) || null;
}

export function updateJob(userId, jobId, patch = {}) {
  const jobs = readJobs(userId);
  const job = jobs.find((item) => item.id === jobId);
  if (!job) {
    const error = new Error("Job not found");
    error.status = 404;
    throw error;
  }
  Object.assign(job, patch, { updatedAt: isoNow() });
  writeJobs(userId, jobs);
  return job;
}

export async function runJob(userId, jobId, processor) {
  updateJob(userId, jobId, { status: "running", startedAt: isoNow(), error: "" });
  try {
    const result = await processor();
    return updateJob(userId, jobId, { status: "completed", completedAt: isoNow(), result });
  } catch (error) {
    return updateJob(userId, jobId, { status: "failed", completedAt: isoNow(), error: error.message || "Job failed" });
  }
}

export function queueStatus() {
  const jobs = listKnownUsers().flatMap((userId) => readJobs(userId).map((job) => ({ userId, ...job })));
  return {
    generatedAt: isoNow(),
    mode: "persisted_local_queue",
    queued: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter((job) => job.status === "running").length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    recentJobs: jobs
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
      .slice(0, 10),
    productionNeeded: ["external_worker_runtime", "retry_backoff_policy", "dead_letter_queue", "worker_metrics"]
  };
}

export async function enqueueWorkerJob(userId, { type, payload = {}, maxAttempts = 5 } = {}) {
  if (!isPostgresStorage()) return addJob(userId, { type,payload,maxAttempts });
  const id = newId("job");
  const result = await postgresQuery(
    `INSERT INTO worker_jobs (id,user_id,job_type,payload,status,max_attempts) VALUES ($1,$2,$3,$4::jsonb,'queued',$5)
     RETURNING id,user_id AS "userId",job_type AS type,payload,status,attempts,max_attempts AS "maxAttempts",created_at AS "createdAt"`,
    [id,userId,type || "general",JSON.stringify(payload),Math.max(1,Number(maxAttempts) || 5)]
  );
  return result.rows[0];
}

export async function startWorkerJob(userId, jobId, workerId = `inline-${process.pid}`) {
  if (!isPostgresStorage()) {
    const current = getJob(userId, jobId);
    if (!current || !["queued","retry"].includes(current.status) || (current.runAfter && Date.parse(current.runAfter) > Date.now())) throw Object.assign(new Error("Worker job is not available to claim."), { status:409 });
    return updateJob(userId, jobId, { status:"running",startedAt:isoNow(),error:"",attempts:Number(current.attempts || 0) + 1 });
  }
  const result = await postgresQuery(
    `UPDATE worker_jobs SET status='running',attempts=attempts+1,locked_at=now(),locked_by=$3,updated_at=now()
     WHERE id=$1 AND user_id=$2 AND status IN ('queued','retry') AND run_after <= now() RETURNING *`, [jobId,userId,workerId]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Worker job is not available to claim."), { status:409 });
  return result.rows[0];
}

export async function completeWorkerJob(userId, jobId, resultPayload = {}) {
  if (!isPostgresStorage()) return updateJob(userId, jobId, { status:"completed",completedAt:isoNow(),result:resultPayload });
  const result = await postgresQuery(
    `UPDATE worker_jobs SET status='completed',result=$3::jsonb,error=NULL,locked_at=NULL,locked_by=NULL,updated_at=now()
     WHERE id=$1 AND user_id=$2 RETURNING *`, [jobId,userId,JSON.stringify(resultPayload)]
  );
  return result.rows[0];
}

export async function failWorkerJob(userId, jobId, error) {
  if (!isPostgresStorage()) {
    const current = getJob(userId, jobId);
    if (!current) return null;
    const attempts = Number(current.attempts || 1);
    const maxAttempts = Number(current.maxAttempts || 5);
    const dead = attempts >= maxAttempts;
    return updateJob(userId, jobId, { status:dead ? "dead_letter" : "retry",runAfter:new Date(Date.now() + Math.min(3600000, 2 ** attempts * 15000)).toISOString(),completedAt:dead ? isoNow() : null,error:error?.message || String(error) });
  }
  const current = await postgresQuery("SELECT attempts,max_attempts FROM worker_jobs WHERE id=$1 AND user_id=$2", [jobId,userId]);
  const row = current.rows[0];
  if (!row) return null;
  const dead = Number(row.attempts) >= Number(row.max_attempts);
  const delaySeconds = Math.min(3600, 2 ** Math.max(1, Number(row.attempts)) * 15);
  const result = await postgresQuery(
    `UPDATE worker_jobs SET status=$3,error=$4,run_after=now()+($5 * interval '1 second'),locked_at=NULL,locked_by=NULL,updated_at=now()
     WHERE id=$1 AND user_id=$2 RETURNING *`, [jobId,userId,dead ? "dead_letter" : "retry",error?.message || String(error),delaySeconds]
  );
  return result.rows[0];
}

export async function queueStatusAsync() {
  if (!isPostgresStorage()) return queueStatus();
  const [counts,recent] = await Promise.all([
    postgresQuery("SELECT status,count(*)::int AS count FROM worker_jobs GROUP BY status"),
    postgresQuery("SELECT id,user_id AS \"userId\",job_type AS type,status,attempts,max_attempts AS \"maxAttempts\",error,created_at AS \"createdAt\",updated_at AS \"updatedAt\" FROM worker_jobs ORDER BY updated_at DESC LIMIT 10")
  ]);
  const byStatus = Object.fromEntries(counts.rows.map((row) => [row.status,Number(row.count)]));
  return { generatedAt:isoNow(),mode:"postgres_worker_queue",queued:(byStatus.queued || 0)+(byStatus.retry || 0),running:byStatus.running || 0,completed:byStatus.completed || 0,failed:byStatus.dead_letter || 0,recentJobs:recent.rows,retryBackoff:true,deadLetter:true };
}

export async function listJobsAsync(userId, { limit = 50,status = "all" } = {}) {
  if (!isPostgresStorage()) return listJobs(userId, { limit,status });
  const values = [userId,Math.min(100,Math.max(1,Number(limit) || 50))];
  const statusClause = status === "all" ? "" : " AND status=$3";
  if (status !== "all") values.push(status);
  const result = await postgresQuery(
    `SELECT id,user_id AS "userId",job_type AS type,payload,status,attempts,max_attempts AS "maxAttempts",run_after AS "runAfter",error,result,created_at AS "createdAt",updated_at AS "updatedAt"
     FROM worker_jobs WHERE user_id=$1${statusClause} ORDER BY updated_at DESC LIMIT $2`, values
  );
  return result.rows;
}

export async function getJobAsync(userId, jobId) {
  if (!isPostgresStorage()) return getJob(userId, jobId);
  const result = await postgresQuery(
    `SELECT id,user_id AS "userId",job_type AS type,payload,status,attempts,max_attempts AS "maxAttempts",error,result,created_at AS "createdAt",updated_at AS "updatedAt"
     FROM worker_jobs WHERE id=$1 AND user_id=$2`, [jobId,userId]
  );
  return result.rows[0] || null;
}
