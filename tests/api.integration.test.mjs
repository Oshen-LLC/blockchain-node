import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectRoot = '/Users/abdulkadir/Desktop/blockchain-node';
const apiPort = Number(process.env.TEST_API_PORT || 4100);
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'blockchain-node-int-'));
const operationsDbPath = path.join(tmpRoot, 'operations.db');

let serverProcess;
let serverLogs = '';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${apiBaseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${apiBaseUrl}/health\n${serverLogs}`);
}

async function api(pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.token) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }
  let body;
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body,
  });

  const contentType = response.headers.get('content-type') || '';
  let payload = null;
  if (contentType.includes('application/json')) {
    payload = await response.json();
  } else {
    payload = await response.text();
  }

  return {
    status: response.status,
    headers: response.headers,
    body: payload,
  };
}

before(async () => {
  serverProcess = spawn('npm', ['start'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(apiPort),
      OPERATIONS_DB_PATH: operationsDbPath,
      SEED_DEV_DATA: process.env.SEED_DEV_DATA || 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (chunk) => {
    serverLogs += chunk.toString();
  });
  serverProcess.stderr.on('data', (chunk) => {
    serverLogs += chunk.toString();
  });

  await waitForHealth();
});

after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGINT');
    await delay(1000);
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

test('auth, ministry operations, certificate verification, fraud workflow, and reports', async () => {
  const suffix = Date.now();
  const institutionName = `Integration Validation Institute ${suffix}`;
  const institutionCode = `IVI${String(suffix).slice(-6)}`;
  const schoolAdminEmail = `school.${suffix}@example.edu`;
  const teacherEmail = `teacher.${suffix}@example.edu`;
  const studentEmail = `student.${suffix}@example.edu`;

  const invalidPassword = await api('/auth/login', {
    method: 'POST',
    body: {
      email: 'verifier@moe.gov.so',
      password: 'wrong-password',
      role: 'certificate_verifier',
    },
  });
  assert.equal(invalidPassword.status, 401);

  const ministryLogin = await api('/auth/login', {
    method: 'POST',
    body: {
      email: 'ministry@moe.gov.so',
      password: 'Ministry123!',
      role: 'ministry_admin',
    },
  });
  assert.equal(ministryLogin.status, 200);
  assert.equal(ministryLogin.body.user.role, 'ministry_admin');
  const ministryToken = ministryLogin.body.token;

  const verifierLogin = await api('/auth/login', {
    method: 'POST',
    body: {
      email: 'verifier@moe.gov.so',
      password: 'Verifier123!',
      role: 'certificate_verifier',
    },
  });
  assert.equal(verifierLogin.status, 200);
  const verifierToken = verifierLogin.body.token;

  const studentLogin = await api('/auth/login', {
    method: 'POST',
    body: {
      email: 'student104@mogadishu.edu.so',
      password: 'Student123!',
      role: 'student',
      studentId: 'STU-104',
    },
  });
  assert.equal(studentLogin.status, 200);
  const studentToken = studentLogin.body.token;

  const studentBroadList = await api('/api/certificates', { token: studentToken });
  assert.equal(studentBroadList.status, 403);

  const institutionCreate = await api('/api/institutions', {
    method: 'POST',
    token: ministryToken,
    body: {
      name: institutionName,
      code: institutionCode,
      type: 'university',
      contactEmail: `ops.${suffix}@example.edu`,
    },
  });
  assert.equal(institutionCreate.status, 201);
  assert.equal(institutionCreate.body.name, institutionName);
  const institutionId = institutionCreate.body.id;

  const schoolAdminCreate = await api('/api/users', {
    method: 'POST',
    token: ministryToken,
    body: {
      name: 'Integration School Admin',
      email: schoolAdminEmail,
      password: 'School123!',
      role: 'school_admin',
      institutionId,
    },
  });
  assert.equal(schoolAdminCreate.status, 201);
  assert.equal(schoolAdminCreate.body.role, 'school_admin');

  const teacherCreate = await api('/api/users', {
    method: 'POST',
    token: ministryToken,
    body: {
      name: 'Integration Teacher',
      email: teacherEmail,
      password: 'Teacher123!',
      role: 'teacher',
      institutionId,
    },
  });
  assert.equal(teacherCreate.status, 201);
  const teacherId = teacherCreate.body.id;

  const studentCreate = await api('/api/users', {
    method: 'POST',
    token: ministryToken,
    body: {
      name: 'Integration Student',
      email: studentEmail,
      password: 'Student123!',
      role: 'student',
      institutionId,
      studentId: `STU-${suffix}`,
    },
  });
  assert.equal(studentCreate.status, 201);

  const schoolAdminLogin = await api('/auth/login', {
    method: 'POST',
    body: {
      email: schoolAdminEmail,
      password: 'School123!',
      role: 'school_admin',
    },
  });
  assert.equal(schoolAdminLogin.status, 200);

  const teacherLogin = await api('/auth/login', {
    method: 'POST',
    body: {
      email: teacherEmail,
      password: 'Teacher123!',
      role: 'teacher',
    },
  });
  assert.equal(teacherLogin.status, 200);
  const teacherToken = teacherLogin.body.token;

  const foreignTeacherLogin = await api('/auth/login', {
    method: 'POST',
    body: {
      email: 'teacher@mogadishu.edu.so',
      password: 'Teacher123!',
      role: 'teacher',
    },
  });
  assert.equal(foreignTeacherLogin.status, 200);
  const foreignTeacherToken = foreignTeacherLogin.body.token;

  const ministrySummary = await api('/api/dashboard/ministry/summary', { token: ministryToken });
  assert.equal(ministrySummary.status, 200);
  assert.ok(ministrySummary.body.totals.institutions >= 1);

  const verifierSummary = await api('/api/dashboard/verifier/summary', { token: verifierToken });
  assert.equal(verifierSummary.status, 200);

  const teacherDashboard = await api('/api/teacher/dashboard/summary', { token: teacherToken });
  assert.equal(teacherDashboard.status, 200);

  const teacherCreateCourse = await api('/api/teacher/courses', {
    method: 'POST',
    token: teacherToken,
    body: {
      title: `Distributed Ledgers ${suffix}`,
      description: 'Teacher flow integration course',
      duration: '6 weeks',
      totalLessons: 12,
    },
  });
  assert.equal(teacherCreateCourse.status, 201);
  const courseId = teacherCreateCourse.body.id;

  const teacherListCourses = await api('/api/teacher/courses', { token: teacherToken });
  assert.equal(teacherListCourses.status, 200);
  assert.ok(teacherListCourses.body.some((course) => course.id === courseId));

  const teacherDirectory = await api('/api/teacher/student-directory', { token: teacherToken });
  assert.equal(teacherDirectory.status, 200);
  assert.ok(teacherDirectory.body.some((student) => student.email === studentEmail));

  const teacherStudentsInitial = await api('/api/teacher/students', { token: teacherToken });
  assert.equal(teacherStudentsInitial.status, 200);
  assert.equal(teacherStudentsInitial.body.some((student) => student.email === studentEmail), false);

  const teacherCreateEnrollment = await api(`/api/teacher/courses/${courseId}/enrollments`, {
    method: 'POST',
    token: teacherToken,
    body: {
      studentUserId: studentCreate.body.id,
    },
  });
  assert.equal(teacherCreateEnrollment.status, 201);
  const enrollmentId = teacherCreateEnrollment.body.id;

  const foreignTeacherEnrollments = await api(`/api/teacher/courses/${courseId}/enrollments`, { token: foreignTeacherToken });
  assert.equal(foreignTeacherEnrollments.status, 404);

  const teacherUpdateEnrollment = await api(`/api/teacher/enrollments/${enrollmentId}`, {
    method: 'PATCH',
    token: teacherToken,
    body: {
      progressPercent: 100,
      completedLessons: 12,
      totalLessons: 12,
      finalGrade: 'A-',
      status: 'completed',
    },
  });
  assert.equal(teacherUpdateEnrollment.status, 200);
  assert.equal(teacherUpdateEnrollment.body.status, 'completed');

  const genericTeacherIssue = await api('/api/certificates', {
    method: 'POST',
    token: teacherToken,
    body: {
      id: `BLOCKED-${suffix}`,
      studentId: `STU-${suffix}`,
      studentName: 'Integration Student',
      degree: 'Computer Science',
      university: institutionName,
      graduationDate: '2026-03-07',
    },
  });
  assert.equal(genericTeacherIssue.status, 403);

  const teacherCertificatesReady = await api('/api/teacher/certificates', { token: teacherToken });
  assert.equal(teacherCertificatesReady.status, 200);
  assert.ok(teacherCertificatesReady.body.readyToIssue.some((entry) => entry.enrollmentId === enrollmentId));

  const issueCertificate = await api(`/api/teacher/enrollments/${enrollmentId}/issue-certificate`, {
    method: 'POST',
    token: teacherToken,
    body: {
      graduationDate: '2026-03-07',
    },
  });
  assert.equal(issueCertificate.status, 201);
  assert.equal(issueCertificate.body.enrollment.certificateIssued, true);
  assert.match(issueCertificate.body.certificate.hash, /^[a-f0-9]{64}$/);
  assert.ok(issueCertificate.body.certificate.id);
  const issuedCertificateId = issueCertificate.body.certificate.id;

  const verifyValid = await api('/api/certificates/verify', {
    method: 'POST',
    token: verifierToken,
    body: {
      id: issuedCertificateId,
      hash: issueCertificate.body.certificate.hash,
    },
  });
  assert.equal(verifyValid.status, 200);
  assert.equal(verifyValid.body.isValid, true);
  assert.ok(verifyValid.body.verificationId);

  const verifyInvalid = await api('/api/certificates/verify', {
    method: 'POST',
    token: verifierToken,
    body: {
      id: issuedCertificateId,
      hash: 'deadbeef',
    },
  });
  assert.equal(verifyInvalid.status, 200);
  assert.equal(verifyInvalid.body.isValid, false);
  assert.equal(verifyInvalid.body.reason, 'Hash mismatch detected.');
  assert.ok(verifyInvalid.body.verificationId);

  const teacherCertificatesIssued = await api('/api/teacher/certificates', { token: teacherToken });
  assert.equal(teacherCertificatesIssued.status, 200);
  assert.equal(teacherCertificatesIssued.body.readyToIssue.some((entry) => entry.enrollmentId === enrollmentId), false);
  assert.ok(teacherCertificatesIssued.body.issued.some((entry) => entry.certificateId === issuedCertificateId));

  const teacherStudentsAfterEnrollment = await api('/api/teacher/students', { token: teacherToken });
  assert.equal(teacherStudentsAfterEnrollment.status, 200);
  assert.ok(teacherStudentsAfterEnrollment.body.some((student) => student.email === studentEmail));

  const teacherAnalytics = await api('/api/teacher/analytics', { token: teacherToken });
  assert.equal(teacherAnalytics.status, 200);
  assert.ok(teacherAnalytics.body.totals.certificatesIssued >= 1);

  const createFraudCase = await api('/api/fraud-cases', {
    method: 'POST',
    token: verifierToken,
    body: {
      verificationEventId: verifyInvalid.body.verificationId,
      reason: 'Hash mismatch detected',
      notes: 'Integration test case',
    },
  });
  assert.equal(createFraudCase.status, 201);
  assert.equal(createFraudCase.body.status, 'open');
  const fraudCaseId = createFraudCase.body.id;

  const updateFraudCase = await api(`/api/fraud-cases/${fraudCaseId}`, {
    method: 'PATCH',
    token: verifierToken,
    body: {
      status: 'investigating',
      notes: 'Issuer suspended by integration test',
      assigneeUserId: teacherId,
      suspendIssuer: true,
    },
  });
  assert.equal(updateFraudCase.status, 200);
  assert.equal(updateFraudCase.body.status, 'investigating');

  const suspendedTeacherIssue = await api('/api/teacher/dashboard/summary', {
    method: 'GET',
    token: teacherToken,
    headers: { accept: 'application/json' },
  });
  assert.equal(suspendedTeacherIssue.status, 403);

  const suspendedTeacherLogin = await api('/auth/login', {
    method: 'POST',
    body: {
      email: teacherEmail,
      password: 'Teacher123!',
      role: 'teacher',
    },
  });
  assert.equal(suspendedTeacherLogin.status, 403);

  const verificationsList = await api('/api/verifications?result=invalid', { token: verifierToken });
  assert.equal(verificationsList.status, 200);
  assert.ok(verificationsList.body.some((entry) => entry.certificateId === issuedCertificateId));

  const fraudCasesList = await api('/api/fraud-cases', { token: verifierToken });
  assert.equal(fraudCasesList.status, 200);
  assert.ok(fraudCasesList.body.some((entry) => entry.id === fraudCaseId));

  const auditsList = await api('/api/audits', { token: ministryToken });
  assert.equal(auditsList.status, 200);
  assert.ok(auditsList.body.some((entry) => entry.action === 'teacher.enrollment.issue-certificate'));

  const networkStatus = await api('/api/network/status', { token: verifierToken });
  assert.equal(networkStatus.status, 200);
  assert.equal(Array.isArray(networkStatus.body.services), true);
  assert.ok(networkStatus.body.services.length >= 3);

  const csvReport = await api('/api/reports/export?type=verifications&format=csv', { token: ministryToken });
  assert.equal(csvReport.status, 200);
  assert.match(csvReport.headers.get('content-type') || '', /text\/csv/);
  assert.match(String(csvReport.body), /Certificate,Result,Reason/);
});
