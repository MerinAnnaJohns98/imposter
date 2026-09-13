const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { scoreRepository, evaluateSubmission, checkRepoExists } = require('./aiScorer');
const { validateRepository } = require('./githubValidator');

console.log('SUPABASE_URL loaded:', !!process.env.SUPABASE_URL);
console.log('SUPABASE_KEY loaded:', !!process.env.SUPABASE_KEY);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.log('Missing Supabase environment variables.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const normalizeGitHubUrl = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const validGitHubUrl = (value) => {
  const url = normalizeGitHubUrl(value);
  return /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/i.test(url);
};

const generateTeamCode = (teamName) => {
  const prefix = String(teamName || '').trim().slice(0, 3).toUpperCase();
  const randomDigits = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}${randomDigits}`;
};

app.get('/', (req, res) => {
  res.json({ message: 'Asthra Imposter Backend Running 🚀' });
});

app.post('/api/register-team', async (req, res) => {
  try {
    const team_name = String(req.body?.team_name || '').trim();
    const members = Array.isArray(req.body?.members) ? req.body.members : [];

    if (!team_name) {
      return res.status(400).json({
        success: false,
        message: 'team_name is required.'
      });
    }

    const cleanMembers = members
      .map((member) => String(member || '').trim())
      .filter((member) => member.length > 0);

    if (cleanMembers.length !== 4) {
      return res.status(400).json({
        success: false,
        message: 'Exactly 4 non-empty member names are required.'
      });
    }

    const existingTeam = await supabase
      .from('teams')
      .select('id, team_name')
      .ilike('team_name', team_name)
      .limit(1);

    if (existingTeam.error) {
      return res.status(500).json({ success: false, message: existingTeam.error.message });
    }

    if (existingTeam.data && existingTeam.data.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Team name already exists.'
      });
    }

    const teamCode = generateTeamCode(team_name);

    const { data: teamData, error: teamError } = await supabase
      .from('teams')
      .insert([
        {
          team_name,
          team_code: teamCode
        }
      ])
      .select();

    if (teamError) {
      return res.status(500).json({ success: false, message: teamError.message });
    }

    const teamId = teamData?.[0]?.id;
    if (!teamId) {
      return res.status(500).json({ success: false, message: 'Team could not be created.' });
    }

    const participantsToInsert = cleanMembers.map((memberName) => ({
      team_id: teamId,
      participant_name: memberName
    }));

    const { error: participantsError } = await supabase
      .from('participants')
      .insert(participantsToInsert);

    if (participantsError) {
      await supabase.from('teams').delete().eq('id', teamId);
      return res.status(500).json({ success: false, message: participantsError.message });
    }

    return res.status(201).json({
      success: true,
      team_code: teamCode,
      message: 'Team registered successfully.'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Team registration failed.' });
  }
});

app.get('/api/registered-teams', async (req, res) => {
  try {
    const { data: teams, error: teamsError } = await supabase
      .from('teams')
      .select('*')
      .order('id', { ascending: true });

    if (teamsError) {
      return res.status(500).json({ success: false, message: teamsError.message });
    }

    const { data: participants, error: participantsError } = await supabase
      .from('participants')
      .select('*')
      .order('id', { ascending: true });

    if (participantsError) {
      return res.status(500).json({ success: false, message: participantsError.message });
    }

    const participantsByTeam = {};
    (participants || []).forEach((participant) => {
      if (!participantsByTeam[participant.team_id]) {
        participantsByTeam[participant.team_id] = [];
      }
      participantsByTeam[participant.team_id].push(participant.participant_name);
    });

    const teamsWithMembers = (teams || []).map((team) => ({
      id: team.id,
      team_name: team.team_name,
      team_code: team.team_code,
      members: participantsByTeam[team.id] || []
    }));

    return res.status(200).json({
      success: true,
      teams: teamsWithMembers,
      total_teams: teamsWithMembers.length,
      total_participants: (participants || []).length
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to fetch registered teams.' });
  }
});

app.get('/api/shuffle-layout', async (req, res) => {
  try {
    const { data: teams, error: teamsError } = await supabase
      .from('teams')
      .select('id, team_name')
      .order('id', { ascending: true });

    if (teamsError) {
      return res.status(500).json({ success: false, message: teamsError.message });
    }

    const { data: participants, error: participantsError } = await supabase
      .from('participants')
      .select('*')
      .order('id', { ascending: true });

    if (participantsError) {
      return res.status(500).json({ success: false, message: participantsError.message });
    }

    // Validate: must have exactly 6 complete teams with 24 participants total
    const completeTeams = (teams || []).filter((team) => {
      const memberCount = (participants || []).filter((p) => p.team_id === team.id).length;
      return memberCount === 4;
    });

    if (!teams || teams.length !== 6 || completeTeams.length !== 6 || (participants || []).length !== 24) {
      return res.status(200).json({
        success: true,
        participants: [],
        seating_ready: false
      });
    }

    // Check that shuffle has actually been run (all participants have a shuffle_group assigned)
    const shuffled = (participants || []).every((p) => p.shuffle_group && p.shuffle_group !== 'Unassigned');
    if (!shuffled) {
      return res.status(200).json({
        success: true,
        participants: [],
        seating_ready: false
      });
    }

    const teamMap = {};
    (teams || []).forEach((team) => {
      teamMap[team.id] = team.team_name;
    });

    const seatRows = (participants || []).map((participant) => ({
      id: participant.id,
      participant_name: participant.participant_name,
      original_team: teamMap[participant.team_id] || 'Unknown Team',
      seating_group: participant.shuffle_group,
      // Use player_role as primary truth — is_imposter boolean may be null/unset in some DB rows
      is_imposter: participant.player_role === 'Imposter' || participant.is_imposter === true,
      role: (participant.player_role === 'Imposter' || participant.is_imposter === true) ? 'Imposter' : 'Specialist'
    }));

    // Sort: within each group, specialists come first (rows 1-3), imposter always last (row 4).
    seatRows.sort((a, b) => {
      // Primary: group name (Group 1, Group 2 … Group 6 — numeric sort)
      const gA = parseInt((a.seating_group || '').replace(/\D/g, ''), 10) || 0;
      const gB = parseInt((b.seating_group || '').replace(/\D/g, ''), 10) || 0;
      if (gA !== gB) return gA - gB;
      // Secondary: specialists (is_imposter=false → 0) before imposter (true → 1)
      return (a.is_imposter ? 1 : 0) - (b.is_imposter ? 1 : 0);
    });

    return res.status(200).json({
      success: true,
      participants: seatRows,
      seating_ready: true
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to fetch seating layout.' });
  }
});

app.post('/api/authenticate', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const team_name = String(req.body?.team_name || '').trim();

    if (!name || !team_name) {
      return res.status(400).json({
        success: false,
        message: 'Both name and team_name are required.'
      });
    }

    const { data: teamData, error: teamError } = await supabase
      .from('teams')
      .select('id, team_name, team_code')
      .eq('team_name', team_name)
      .maybeSingle();

    if (teamError) {
      return res.status(500).json({ success: false, message: teamError.message });
    }

    if (!teamData) {
      return res.status(404).json({
        success: false,
        message: 'Invalid Team or Participant Name.'
      });
    }

    // Only select the fields needed — never expose group, original team mapping, or teammates
    const { data: participantData, error: participantError } = await supabase
      .from('participants')
      .select('id, participant_name, player_role, shuffle_group')
      .eq('team_id', teamData.id)
      .eq('participant_name', name)
      .maybeSingle();

    if (participantError) {
      return res.status(500).json({ success: false, message: participantError.message });
    }

    if (!participantData) {
      return res.status(404).json({
        success: false,
        message: 'Invalid Team or Participant Name.'
      });
    }

    // Require shuffle to have been run before login is allowed
    if (!participantData.player_role || !participantData.shuffle_group) {
      return res.status(403).json({
        success: false,
        message: 'The event has not started yet. Please wait for the coordinator to run the shuffle.'
      });
    }

    // Normalise role: treat any non-Imposter role as Specialist
    const role = participantData.player_role === 'Imposter' ? 'Imposter' : 'Specialist';

    // Return only what the participant needs — no group number, no team mapping
    return res.status(200).json({
      success: true,
      message: 'Authentication successful.',
      user: {
        id: participantData.id,
        name: participantData.participant_name,
        team_name: teamData.team_name,
        team_code: teamData.team_code,
        role: role
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Authentication failed.' });
  }
});

app.post('/api/start-shuffle', async (req, res) => {
  try {
    const { data: allTeams, error: teamsError } = await supabase
      .from('teams')
      .select('id, team_name, team_code');

    if (teamsError) {
      return res.status(500).json({ success: false, message: teamsError.message });
    }

    const { data: allParticipants, error: participantsError } = await supabase
      .from('participants')
      .select('*');

    if (participantsError) {
      return res.status(500).json({ success: false, message: participantsError.message });
    }

    if (!Array.isArray(allTeams) || allTeams.length === 0) {
      return res.status(400).json({ success: false, message: 'No teams registered.' });
    }

    // ── Validate: exactly 6 complete teams ────────────────────────────────────
    const teamMap = {};
    allTeams.forEach((team) => { teamMap[team.id] = team; });

    const participantsByTeam = {};
    allParticipants.forEach((p) => {
      if (!participantsByTeam[p.team_id]) participantsByTeam[p.team_id] = [];
      participantsByTeam[p.team_id].push(p);
    });

    const teamIds = Object.keys(participantsByTeam);
    if (teamIds.length !== 6 || teamIds.some((tid) => participantsByTeam[tid].length !== 4)) {
      return res.status(400).json({
        success: false,
        message: 'Exactly 6 teams with 4 members each are required to run the shuffle.'
      });
    }

    // ── Step A: Pick exactly 1 random imposter per original team ─────────────
    // Shuffle each team's member list and take the first element as imposter.
    const imposters = [];
    const specialistsByTeam = {};   // team_id → [3 remaining specialists]

    for (const teamId of teamIds) {
      const shuffled = [...participantsByTeam[teamId]].sort(() => Math.random() - 0.5);
      imposters.push(shuffled[0]);
      specialistsByTeam[teamId] = shuffled.slice(1);   // the other 3
    }

    // ── Step B: Shuffle imposters into random group order ─────────────────────
    const shuffledImposters = [...imposters].sort(() => Math.random() - 0.5);

    // ── Step C: Build 6 groups — each starts empty (no pre-seeded imposter) ──
    // We'll assign specialists first, then place each imposter at the end.
    const groups = Array.from({ length: 6 }, (_, i) => ({
      groupName:  `Group ${i + 1}`,
      imposter:   shuffledImposters[i],
      specialists: []              // will hold exactly 3 specialists
    }));

    // Flatten all 18 specialists into one pool
    const allSpecialists = [];
    for (const teamId of teamIds) {
      allSpecialists.push(...specialistsByTeam[teamId]);
    }

    // ── Step D: Assign specialists (retry loop, up to 500 attempts) ───────────
    // Rule: a specialist must not share an original team with the group's imposter
    //       OR with any other specialist already in that group.
    let assigned = false;
    let attempt  = 0;

    while (!assigned && attempt < 500) {
      attempt++;

      const working = groups.map((g) => ({
        groupName:   g.groupName,
        imposter:    g.imposter,
        specialists: []
      }));

      const pool = [...allSpecialists].sort(() => Math.random() - 0.5);
      let valid  = true;

      for (const specialist of pool) {
        // Eligible groups: have space (< 3 specialists) AND no team conflict
        const eligible = working.filter((wg) => {
          if (wg.specialists.length >= 3) return false;
          if (wg.imposter.team_id === specialist.team_id) return false;
          if (wg.specialists.some((s) => s.team_id === specialist.team_id)) return false;
          return true;
        });

        if (eligible.length === 0) { valid = false; break; }

        const chosen = eligible[Math.floor(Math.random() * eligible.length)];
        chosen.specialists.push(specialist);
      }

      if (valid && working.every((wg) => wg.specialists.length === 3)) {
        assigned = true;
        working.forEach((wg, i) => { groups[i].specialists = wg.specialists; });
      }
    }

    if (!assigned) {
      return res.status(400).json({
        success: false,
        message: 'Unable to create a valid seating arrangement after 500 attempts. This should not happen with 6 teams of 4. Check for duplicate team memberships.'
      });
    }

    // ── Step 1: Write participants table (is_imposter, shuffle_group, player_role) ──
    for (const group of groups) {
      // Specialists
      for (const member of group.specialists) {
        const { error: updateError } = await supabase
          .from('participants')
          .update({
            is_imposter:   false,
            shuffle_group: group.groupName,
            player_role:   'Specialist'
          })
          .eq('id', member.id);

        if (updateError) {
          return res.status(500).json({ success: false, message: updateError.message });
        }
      }

      // Imposter
      const { error: impUpdateError } = await supabase
        .from('participants')
        .update({
          is_imposter:   true,
          shuffle_group: group.groupName,
          player_role:   'Imposter'
        })
        .eq('id', group.imposter.id);

      if (impUpdateError) {
        return res.status(500).json({ success: false, message: impUpdateError.message });
      }
    }

    // ── Step 2: Load main_event_tasks (optional — fallback if missing) ────────
    const { data: tasks, error: tasksError } = await supabase
      .from('main_event_tasks')
      .select('*')
      .order('task_number', { ascending: true });

    console.log('[shuffle] tasks fetched:', tasks ? tasks.length : 0, tasksError ? 'ERR:' + tasksError.message : '');

    // Build a task lookup — works with 0, 1, 2, or 3 tasks.
    // If a task is missing we use a placeholder so the insert always runs.
    const taskByNumber = {};
    (tasks || []).forEach((t) => { taskByNumber[t.task_number] = t; });

    const fallbackTask = (num) => ({
      task_number:      num,
      task_title:       `Task ${num}`,
      task_description: `Main event task ${num}. Details to be announced.`,
      person1_title: 'Role 1', person1_work: 'Work assigned by coordinator.',
      person2_title: 'Role 2', person2_work: 'Work assigned by coordinator.',
      person3_title: 'Role 3', person3_work: 'Work assigned by coordinator.',
      person4_title: 'The Imposter', person4_secret: 'Your secret objective will be revealed by the coordinator.'
    });

    const getTask = (num) => taskByNumber[num] || fallbackTask(num);

    // Task mapping: Groups 1 & 4 → Task 1, Groups 2 & 5 → Task 2, Groups 3 & 6 → Task 3
    const taskForGroup = (groupName) => {
      const match    = groupName.match(/\d+/);
      const groupNum = match ? parseInt(match[0], 10) : 1;
      const taskNum  = ((groupNum - 1) % 3) + 1;
      return getTask(taskNum);
    };

    // Slot data — specialists get person1/2/3 work; imposter ALWAYS gets person4_secret
    const slotData = (task, slot) => {
      const map = {
        1: { role_name: task.person1_title, work_description: task.person1_work },
        2: { role_name: task.person2_title, work_description: task.person2_work },
        3: { role_name: task.person3_title, work_description: task.person3_work },
        4: { role_name: task.person4_title, work_description: task.person4_secret }
      };
      return map[slot] || map[1];
    };

    // ── Step 3: Delete all previous assignments ───────────────────────────────
    // Use gte on created_at (universal — works for both UUID and SERIAL id columns)
    const { error: deleteError } = await supabase
      .from('main_event_assignments')
      .delete()
      .gte('created_at', '1970-01-01T00:00:00.000Z');

    if (deleteError) {
      console.error('[shuffle] delete assignments error:', deleteError);
      // Non-fatal if table is empty — log and continue
      console.warn('[shuffle] continuing despite delete error');
    }

    // ── Step 4: Build 24 assignment rows (3 specialists + 1 imposter per group) ─
    const assignmentRows = [];

    for (const group of groups) {
      const task = taskForGroup(group.groupName);

      // Specialists → slots 1, 2, 3
      group.specialists.forEach((member, idx) => {
        const slot = idx + 1;
        const sd   = slotData(task, slot);
        const originalTeam = (teamMap[member.team_id] || {}).team_name || 'Unknown';

        assignmentRows.push({
          participant_id:    member.id,
          participant_name:  member.participant_name,
          original_team:     originalTeam,
          shuffled_group:    group.groupName,
          task_number:       task.task_number,
          task_title:        task.task_title,
          task_description:  task.task_description,
          person_slot:       slot,
          role_name:         sd.role_name,
          work_description:  sd.work_description,
          is_imposter:       false,
          github_repo:       null,
          submission_status: 'Pending',
          submitted_at:      null,
          ai_score:          null
        });
      });

      // Imposter → always slot 4
      const imp     = group.imposter;
      const impSd   = slotData(task, 4);
      const impTeam = (teamMap[imp.team_id] || {}).team_name || 'Unknown';

      assignmentRows.push({
        participant_id:    imp.id,
        participant_name:  imp.participant_name,
        original_team:     impTeam,
        shuffled_group:    group.groupName,
        task_number:       task.task_number,
        task_title:        task.task_title,
        task_description:  task.task_description,
        person_slot:       4,
        role_name:         impSd.role_name,
        work_description:  impSd.work_description,
        is_imposter:       true,
        github_repo:       null,
        submission_status: 'Pending',
        submitted_at:      null,
        ai_score:          null
      });
    }

    console.log('[shuffle] inserting', assignmentRows.length, 'assignment rows');
    console.log('[shuffle] first row sample:', JSON.stringify(assignmentRows[0], null, 2));

    const { data: insertedData, error: insertError } = await supabase
      .from('main_event_assignments')
      .insert(assignmentRows)
      .select();

    if (insertError) {
      console.error('[shuffle] Assignment Insert Error:', JSON.stringify(insertError, null, 2));
      return res.status(500).json({
        success:  false,
        message:  'Assignment insert failed: ' + insertError.message,
        hint:     insertError.hint || null,
        details:  insertError.details || null,
        code:     insertError.code || null
      });
    }

    const insertedCount = insertedData ? insertedData.length : assignmentRows.length;
    console.log('[shuffle] inserted rows:', insertedCount);

    return res.status(200).json({
      success:             true,
      imposters_selected:  6,
      groups_created:      6,
      assignments_written: true,
      assignments_count:   insertedCount,
      tasks_seeded:        (tasks || []).length > 0
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Shuffle could not be started.' });
  }
});

// ── POST /api/debug-assign ────────────────────────────────────────────────────
// Emergency endpoint: reads already-shuffled participants and force-writes
// main_event_assignments. Call this if the table is empty after a shuffle.
// GET /api/debug-assign also works for easy browser testing.
app.get('/api/debug-assign', handleDebugAssign);
app.post('/api/debug-assign', handleDebugAssign);

async function handleDebugAssign(req, res) {
  try {
    const { data: allTeams, error: teamsError } = await supabase
      .from('teams').select('id, team_name');
    if (teamsError) return res.status(500).json({ success: false, message: teamsError.message });

    const { data: allParticipants, error: pErr } = await supabase
      .from('participants').select('*');
    if (pErr) return res.status(500).json({ success: false, message: pErr.message });

    const teamMap = {};
    allTeams.forEach((t) => { teamMap[t.id] = t; });

    // Only use participants that have been shuffled
    const shuffled = (allParticipants || []).filter((p) => p.shuffle_group);
    if (shuffled.length === 0) {
      return res.status(400).json({ success: false, message: 'No shuffled participants found. Run Shuffle All Teams first.' });
    }

    const { data: tasks } = await supabase
      .from('main_event_tasks').select('*').order('task_number', { ascending: true });

    const taskByNumber = {};
    (tasks || []).forEach((t) => { taskByNumber[t.task_number] = t; });

    const fallback = (num) => ({
      task_number: num, task_title: `Task ${num}`,
      task_description: `Main event task ${num}.`,
      person1_title: 'Role 1', person1_work: 'To be announced.',
      person2_title: 'Role 2', person2_work: 'To be announced.',
      person3_title: 'Role 3', person3_work: 'To be announced.',
      person4_title: 'The Imposter', person4_secret: 'Secret objective — see coordinator.'
    });

    const getTask = (num) => taskByNumber[num] || fallback(num);

    const taskForGroup = (groupName) => {
      const m = groupName.match(/\d+/);
      const n = m ? parseInt(m[0], 10) : 1;
      return getTask(((n - 1) % 3) + 1);
    };

    const slotData = (task, slot) => ({
      1: { role_name: task.person1_title, work_description: task.person1_work },
      2: { role_name: task.person2_title, work_description: task.person2_work },
      3: { role_name: task.person3_title, work_description: task.person3_work },
      4: { role_name: task.person4_title, work_description: task.person4_secret }
    }[slot] || { role_name: 'Role 1', work_description: 'To be announced.' });

    // Group participants by shuffle_group, imposters last
    const byGroup = {};
    shuffled.forEach((p) => {
      if (!byGroup[p.shuffle_group]) byGroup[p.shuffle_group] = { specialists: [], imposter: null };
      if (p.is_imposter || p.player_role === 'Imposter') {
        byGroup[p.shuffle_group].imposter = p;
      } else {
        byGroup[p.shuffle_group].specialists.push(p);
      }
    });

    // Delete old rows
    await supabase.from('main_event_assignments').delete()
      .gte('created_at', '1970-01-01T00:00:00.000Z');

    const rows = [];
    for (const [groupName, groupData] of Object.entries(byGroup)) {
      const task = taskForGroup(groupName);
      groupData.specialists.forEach((m, idx) => {
        const slot = idx + 1;
        const sd = slotData(task, slot);
        rows.push({
          participant_id: m.id, participant_name: m.participant_name,
          original_team: (teamMap[m.team_id] || {}).team_name || 'Unknown',
          shuffled_group: groupName, task_number: task.task_number,
          task_title: task.task_title, task_description: task.task_description,
          person_slot: slot, role_name: sd.role_name, work_description: sd.work_description,
          is_imposter: false, github_repo: null, submission_status: 'Pending',
          submitted_at: null, ai_score: null
        });
      });
      if (groupData.imposter) {
        const imp = groupData.imposter;
        const sd = slotData(task, 4);
        rows.push({
          participant_id: imp.id, participant_name: imp.participant_name,
          original_team: (teamMap[imp.team_id] || {}).team_name || 'Unknown',
          shuffled_group: groupName, task_number: task.task_number,
          task_title: task.task_title, task_description: task.task_description,
          person_slot: 4, role_name: sd.role_name, work_description: sd.work_description,
          is_imposter: true, github_repo: null, submission_status: 'Pending',
          submitted_at: null, ai_score: null
        });
      }
    }

    console.log('[debug-assign] inserting', rows.length, 'rows');
    console.log('[debug-assign] sample row:', JSON.stringify(rows[0], null, 2));

    const { data: inserted, error: insertError } = await supabase
      .from('main_event_assignments').insert(rows).select();

    if (insertError) {
      console.error('[debug-assign] insert error:', JSON.stringify(insertError, null, 2));
      return res.status(500).json({
        success: false, message: insertError.message,
        hint: insertError.hint, code: insertError.code, details: insertError.details
      });
    }

    return res.status(200).json({
      success: true,
      inserted: inserted ? inserted.length : rows.length,
      message: `Inserted ${inserted ? inserted.length : rows.length} assignment rows.`
    });
  } catch (err) {
    console.error('[debug-assign] error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/my-assignment/:participantId ────────────────────────────────────
// Returns the logged-in participant's task assignment.
// participantId is a UUID string — never parse as integer.
app.get('/api/my-assignment/:participantId', async (req, res) => {
  try {
    const participantId = String(req.params.participantId || '').trim();

    if (!participantId) {
      return res.status(400).json({ success: false, message: 'Valid participant_id is required.' });
    }

    const { data, error } = await supabase
      .from('main_event_assignments')
      .select(
        'participant_id, participant_name, original_team, shuffled_group, ' +
        'task_number, task_title, task_description, ' +
        'person_slot, role_name, work_description, is_imposter, ' +
        'github_repo, submission_status, evaluation_status, submitted_at, ' +
        'ai_score, ui_score, task_match_score, logic_score, creativity_score, code_quality_score, ai_feedback'
      )
      .eq('participant_id', participantId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'No assignment found. The coordinator may not have run the shuffle yet.'
      });
    }

    return res.status(200).json({ success: true, assignment: data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch assignment.' });
  }
});

// ── POST /api/submit-github ──────────────────────────────────────────────────
// Validates URL via githubValidator, checks for duplicates, saves to Supabase,
// then triggers background AI evaluation.
app.post('/api/submit-github', async (req, res) => {
  try {
    const participant_id = String(req.body?.participant_id || '').trim();
    const github_repo    = normalizeGitHubUrl(req.body?.github_repo);

    if (!participant_id) {
      return res.status(400).json({ success: false, message: 'participant_id is required.' });
    }

    // ── Step 1: URL format check ─────────────────────────────────────────────
    if (!github_repo || !validGitHubUrl(github_repo)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid GitHub repository URL.'
      });
    }

    // ── Step 2: Check assignment + duplicate guard ────────────────────────────
    const { data: existing, error: fetchError } = await supabase
      .from('main_event_assignments')
      .select('participant_id, submission_status, github_repo')
      .eq('participant_id', participant_id)
      .maybeSingle();

    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!existing)  return res.status(404).json({ success: false, message: 'Assignment not found for this participant.' });

    if (existing.submission_status === 'Submitted' || existing.submission_status === 'Evaluated') {
      return res.status(409).json({
        success:     false,
        message:     'You have already submitted. Only one submission is allowed.',
        github_repo: existing.github_repo
      });
    }

    // ── Step 3: Full GitHub validation via githubValidator.js ────────────────
    const validation = await validateRepository(github_repo);
    console.log('[GitHub Validation]', validation);

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.message
      });
    }

    // ── Step 4: Save to Supabase (repo + metadata) ────────────────────────────
    console.log('[GitHub Submitted]', participant_id, github_repo);

    const { error: updateError } = await supabase
      .from('main_event_assignments')
      .update({
        github_repo,
        github_owner:     validation.owner,
        github_repo_name: validation.repo,
        github_branch:    validation.defaultBranch,
        submission_status: 'Submitted',
        submitted_at:      new Date().toISOString()
      })
      .eq('participant_id', participant_id);

    if (updateError) return res.status(500).json({ success: false, message: updateError.message });

    // ── Step 5: Background AI evaluation (fire-and-forget) ───────────────────
    setImmediate(async () => {
      try {
        const { data: asgn } = await supabase
          .from('main_event_assignments')
          .select('participant_id, participant_name, github_repo, task_title, task_description, role_name, work_description, is_imposter')
          .eq('participant_id', participant_id)
          .maybeSingle();

        if (!asgn || !asgn.github_repo) return;

        const result = await evaluateSubmission({
          github_repo:      asgn.github_repo,
          task_title:       asgn.task_title,
          task_description: asgn.task_description,
          role_name:        asgn.role_name,
          work_description: asgn.work_description,
          is_imposter:      asgn.is_imposter
        });

        await supabase.from('main_event_assignments').update({
          ai_score:           result.total_score,
          ui_score:           result.ui_score,
          task_match_score:   result.task_completion_score,
          logic_score:        result.logic_score,
          creativity_score:   result.creativity_score,
          code_quality_score: result.responsiveness_score,
          ai_feedback:        result.feedback,
          evaluation_status:  'Evaluated',
          submission_status:  'Evaluated'
        }).eq('participant_id', participant_id);

        console.log('[eval] Completed for', asgn.participant_name, '— score:', result.total_score);
      } catch (evalErr) {
        console.error('[eval] Background evaluation failed for', participant_id, ':', evalErr.message);
      }
    });

    return res.status(200).json({
      success: true,
      message: 'GitHub repository submitted successfully.',
      repository: {
        owner:  validation.owner,
        name:   validation.repo,
        branch: validation.defaultBranch
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Submission failed.' });
  }
});

// ── POST /api/evaluate-submission/:participantId ──────────────────────────────
// Downloads repo, runs Groq AI, saves all score columns + feedback.
// Can be called by admin to manually re-evaluate.
app.post('/api/evaluate-submission/:participantId', async (req, res) => {
  try {
    const participantId = String(req.params.participantId || '').trim();
    if (!participantId) return res.status(400).json({ success: false, message: 'participantId is required.' });

    const { data: assignment, error: fetchError } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, github_repo, submission_status, task_title, task_description, role_name, work_description, is_imposter')
      .eq('participant_id', participantId)
      .maybeSingle();

    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found.' });
    if (!assignment.github_repo) return res.status(400).json({ success: false, message: 'No GitHub repository has been submitted yet.' });

    const result = await evaluateSubmission({
      github_repo:      assignment.github_repo,
      task_title:       assignment.task_title,
      task_description: assignment.task_description,
      role_name:        assignment.role_name,
      work_description: assignment.work_description,
      is_imposter:      assignment.is_imposter
    });

    const { error: updateError } = await supabase
      .from('main_event_assignments')
      .update({
        ai_score:           result.total_score,
        ui_score:           result.ui_score,
        task_match_score:   result.task_completion_score,
        logic_score:        result.logic_score,
        creativity_score:   result.creativity_score,
        code_quality_score: result.responsiveness_score,
        ai_feedback:        result.feedback,
        evaluation_status:  'Evaluated',
        submission_status:  'Evaluated'
      })
      .eq('participant_id', participantId);

    if (updateError) return res.status(500).json({ success: false, message: updateError.message });

    return res.status(200).json({
      success:              true,
      participant:          assignment.participant_name,
      score:                result.total_score,
      status:               'Evaluated',
      ui_score:             result.ui_score,
      task_completion_score: result.task_completion_score,
      logic_score:          result.logic_score,
      responsiveness_score: result.responsiveness_score,
      creativity_score:     result.creativity_score,
      feedback:             result.feedback
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Evaluation failed.' });
  }
});

// ── GET /api/submitted-participants ──────────────────────────────────────────
// Admin endpoint — all Submitted + Evaluated participants, newest first.
app.get('/api/submitted-participants', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('main_event_assignments')
      .select(
        'participant_id, participant_name, original_team, shuffled_group, github_repo, ' +
        'submission_status, evaluation_status, submitted_at, ' +
        'ai_score, ui_score, task_match_score, logic_score, creativity_score, code_quality_score, ' +
        'ai_feedback, task_title, task_number, role_name, person_slot'
      )
      .in('submission_status', ['Submitted', 'Evaluated'])
      .order('submitted_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });

    return res.status(200).json({ success: true, participants: data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch submissions.' });
  }
});

// ── GET /api/all-assignments ──────────────────────────────────────────────────
// Admin endpoint — all 24 assignments with current status (for overview counts).
app.get('/api/all-assignments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, original_team, submission_status, evaluation_status, ai_score, github_repo');

    if (error) return res.status(500).json({ success: false, message: error.message });

    return res.status(200).json({ success: true, assignments: data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch assignments.' });
  }
});

// ── GET /api/team-scoreboard ──────────────────────────────────────────────────
// Groups evaluated scores by original_team. Used for Team Podium.
app.get('/api/team-scoreboard', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('main_event_assignments')
      .select('original_team, ai_score, submission_status');

    if (error) return res.status(500).json({ success: false, message: error.message });

    // Aggregate by original_team
    const teamMap = {};
    (data || []).forEach((row) => {
      const team = row.original_team || 'Unknown';
      if (!teamMap[team]) teamMap[team] = { team, members_evaluated: 0, team_total: 0 };
      if (row.submission_status === 'Evaluated' && row.ai_score != null) {
        teamMap[team].members_evaluated++;
        teamMap[team].team_total += Number(row.ai_score);
      }
    });

    const scoreboard = Object.values(teamMap)
      .map((t) => ({
        team:              t.team,
        members_evaluated: t.members_evaluated,
        team_total:        t.team_total,
        average_score:     t.members_evaluated > 0 ? Math.round(t.team_total / t.members_evaluated) : 0
      }))
      .sort((a, b) => b.team_total - a.team_total);

    return res.status(200).json({ success: true, scoreboard });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch scoreboard.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN API ROUTES — Features 1–15
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/participants ───────────────────────────────────────────────
// All 24 participants with full assignment + submission + score data
app.get('/api/admin/participants', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('main_event_assignments')
      .select('*')
      .order('shuffled_group', { ascending: true });
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, participants: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/overview ───────────────────────────────────────────────────
// Counts + recent submissions + task distribution grouped by shuffled group
app.get('/api/admin/overview', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('main_event_assignments')
      .select('*')
      .order('submitted_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, message: error.message });

    const all        = data || [];
    const total      = all.length;
    const submitted  = all.filter(r => r.submission_status === 'Submitted' || r.submission_status === 'Evaluated').length;
    const evaluated  = all.filter(r => r.submission_status === 'Evaluated').length;
    const pending    = total - submitted;
    const recent     = all.filter(r => r.github_repo).slice(0, 8);

    // Group distribution for task assignments section
    const byGroup = {};
    all.forEach(r => {
      if (!byGroup[r.shuffled_group]) byGroup[r.shuffled_group] = [];
      byGroup[r.shuffled_group].push(r);
    });

    return res.status(200).json({
      success: true,
      counts: { total, submitted, evaluated, pending },
      recent,
      task_distribution: byGroup
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/team-scores ────────────────────────────────────────────────
// Per-team aggregation: main_event_score + fizzbuzz_score + manual scores
app.get('/api/admin/team-scores', async (req, res) => {
  try {
    const [assignRes, manualRes] = await Promise.all([
      supabase.from('main_event_assignments')
        .select('original_team, main_event_score, fizzbuzz_score, ai_score'),
      supabase.from('manual_event_scores')
        .select('original_team, event_name, marks')
    ]);

    if (assignRes.error) return res.status(500).json({ success: false, message: assignRes.error.message });

    const teamMap = {};
    (assignRes.data || []).forEach(r => {
      const t = r.original_team || 'Unknown';
      if (!teamMap[t]) teamMap[t] = { team: t, main_event_total: 0, fizzbuzz_total: 0, manual_total: 0, grand_total: 0 };
      teamMap[t].main_event_total += Number(r.main_event_score || 0);
      teamMap[t].fizzbuzz_total   += Number(r.fizzbuzz_score   || 0);
    });

    (manualRes.data || []).forEach(r => {
      const t = r.original_team || 'Unknown';
      if (!teamMap[t]) teamMap[t] = { team: t, main_event_total: 0, fizzbuzz_total: 0, manual_total: 0, grand_total: 0 };
      teamMap[t].manual_total += Number(r.marks || 0);
    });

    const scores = Object.values(teamMap).map(t => {
      t.grand_total = t.main_event_total + t.fizzbuzz_total + t.manual_total;
      return t;
    }).sort((a, b) => b.grand_total - a.grand_total);

    return res.status(200).json({ success: true, scores });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/podium ─────────────────────────────────────────────────────
// Same as team-scores but shaped for podium display
app.get('/api/admin/podium', async (req, res) => {
  try {
    const [assignRes, manualRes] = await Promise.all([
      supabase.from('main_event_assignments')
        .select('original_team, main_event_score, fizzbuzz_score'),
      supabase.from('manual_event_scores')
        .select('original_team, event_name, marks')
    ]);

    if (assignRes.error) return res.status(500).json({ success: false, message: assignRes.error.message });

    const teamMap = {};
    (assignRes.data || []).forEach(r => {
      const t = r.original_team || 'Unknown';
      if (!teamMap[t]) teamMap[t] = { team: t, main_event_total: 0, fizzbuzz_total: 0, manual_total: 0, members_scored: 0 };
      if (r.main_event_score > 0 || r.fizzbuzz_score > 0) teamMap[t].members_scored++;
      teamMap[t].main_event_total += Number(r.main_event_score || 0);
      teamMap[t].fizzbuzz_total   += Number(r.fizzbuzz_score   || 0);
    });

    // Group manual by event per team
    const manualByTeam = {};
    (manualRes.data || []).forEach(r => {
      const t = r.original_team;
      if (!manualByTeam[t]) manualByTeam[t] = {};
      manualByTeam[t][r.event_name] = Number(r.marks || 0);
    });

    const podium = Object.values(teamMap).map(t => {
      const manual = manualByTeam[t.team] || {};
      const manual_total = Object.values(manual).reduce((s, v) => s + v, 0);
      return {
        ...t,
        manual_breakdown: manual,
        manual_total,
        grand_total: t.main_event_total + t.fizzbuzz_total + manual_total
      };
    }).sort((a, b) => b.grand_total - a.grand_total);

    return res.status(200).json({ success: true, podium });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/admin/unlock-submission ─────────────────────────────────────────
// Coordinator unlocks a participant's submission so they can resubmit
app.post('/api/admin/unlock-submission', async (req, res) => {
  try {
    const participant_id = String(req.body?.participant_id || '').trim();
    if (!participant_id) return res.status(400).json({ success: false, message: 'participant_id is required.' });

    const { error } = await supabase
      .from('main_event_assignments')
      .update({
        github_repo:        null,
        github_owner:       null,
        github_repo_name:   null,
        github_branch:      null,
        submitted_at:       null,
        submission_status:  'Pending',
        evaluation_status:  'Pending',
        submission_locked:  false,
        ai_score:           null,
        ai_feedback:        null,
        ui_score:           null,
        task_match_score:   null,
        logic_score:        null,
        creativity_score:   null,
        code_quality_score: null
      })
      .eq('participant_id', participant_id);

    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, message: 'Submission unlocked. Participant can resubmit.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/admin/update-main-event-score ───────────────────────────────────
app.post('/api/admin/update-main-event-score', async (req, res) => {
  try {
    const participant_id    = String(req.body?.participant_id || '').trim();
    const main_event_score  = Number(req.body?.score);
    if (!participant_id || isNaN(main_event_score)) {
      return res.status(400).json({ success: false, message: 'participant_id and score are required.' });
    }
    const { error } = await supabase
      .from('main_event_assignments')
      .update({ main_event_score: Math.min(100, Math.max(0, main_event_score)) })
      .eq('participant_id', participant_id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/admin/update-fizzbuzz-score ─────────────────────────────────────
app.post('/api/admin/update-fizzbuzz-score', async (req, res) => {
  try {
    const participant_id = String(req.body?.participant_id || '').trim();
    const fizzbuzz_score = Number(req.body?.score);
    if (!participant_id || isNaN(fizzbuzz_score)) {
      return res.status(400).json({ success: false, message: 'participant_id and score are required.' });
    }
    const { error } = await supabase
      .from('main_event_assignments')
      .update({ fizzbuzz_score: Math.min(100, Math.max(0, fizzbuzz_score)) })
      .eq('participant_id', participant_id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/admin/manual-score ──────────────────────────────────────────────
// Upsert manual event marks for an original team
app.post('/api/admin/manual-score', async (req, res) => {
  try {
    const event_name    = String(req.body?.event_name    || '').trim();
    const original_team = String(req.body?.original_team || '').trim();
    const marks         = Number(req.body?.marks);

    if (!event_name || !original_team || isNaN(marks)) {
      return res.status(400).json({ success: false, message: 'event_name, original_team, and marks are required.' });
    }

    const safeMarks = Math.min(100, Math.max(0, marks));
    const now       = new Date().toISOString();

    // Try update first (row may already exist)
    const { data: existing } = await supabase
      .from('manual_event_scores')
      .select('id')
      .eq('event_name', event_name)
      .eq('original_team', original_team)
      .maybeSingle();

    let error;
    if (existing) {
      // Row exists — update it
      const result = await supabase
        .from('manual_event_scores')
        .update({ marks: safeMarks, updated_at: now })
        .eq('event_name', event_name)
        .eq('original_team', original_team);
      error = result.error;
    } else {
      // Row doesn't exist — insert it
      const result = await supabase
        .from('manual_event_scores')
        .insert({ event_name, original_team, marks: safeMarks, updated_at: now });
      error = result.error;
    }

    if (error) {
      console.error('[manual-score] Supabase error:', error);
      return res.status(500).json({ success: false, message: error.message, hint: error.hint, code: error.code });
    }
    return res.status(200).json({ success: true, message: 'Marks saved.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/event-progress ─────────────────────────────────────────────
// Dynamic event flow status for all phases
app.get('/api/admin/event-progress', async (req, res) => {
  try {
    const [assignRes, teamsRes, manualRes] = await Promise.all([
      supabase.from('main_event_assignments').select('submission_status, fizzbuzz_score, main_event_score, original_team'),
      supabase.from('participants').select('id'),
      supabase.from('manual_event_scores').select('event_name, original_team')
    ]);

    const all          = assignRes.data || [];
    const totalPart    = (teamsRes.data  || []).length;
    const totalAssign  = all.length;
    const submitted    = all.filter(r => r.submission_status === 'Submitted' || r.submission_status === 'Evaluated').length;
    const evaluated    = all.filter(r => r.submission_status === 'Evaluated').length;
    const fizzDone     = all.filter(r => r.fizzbuzz_score != null && r.fizzbuzz_score > 0).length;
    const mainDone     = all.filter(r => r.main_event_score != null && r.main_event_score > 0).length;

    // Manual events — need all 6 teams to have marks for each event
    const MANUAL_EVENTS = ['Code Imposter', 'Sherlock Holmes', 'Drawing'];
    const manualRecords = manualRes.data || [];
    const manualStatus  = {};
    MANUAL_EVENTS.forEach(ev => {
      const count = manualRecords.filter(r => r.event_name === ev).length;
      manualStatus[ev] = count;
    });

    const uniqueTeams = [...new Set(all.map(r => r.original_team))].length;

    return res.status(200).json({
      success: true,
      progress: {
        registration:    { done: totalPart >= 24,        label: `${totalPart}/24 participants` },
        shuffle:         { done: totalAssign >= 24,      label: totalAssign >= 24 ? 'Groups assigned' : 'Not run' },
        github_submission:{ done: submitted >= 24,       label: `${submitted}/24 submitted` },
        ai_evaluation:   { done: evaluated >= 24,        label: `${evaluated}/24 evaluated` },
        fizzbuzz:        { done: fizzDone >= totalAssign,label: `${fizzDone}/${totalAssign} scored` },
        code_imposter:   { done: (manualStatus['Code Imposter']||0) >= uniqueTeams, label: `${manualStatus['Code Imposter']||0}/${uniqueTeams} teams` },
        sherlock_holmes: { done: (manualStatus['Sherlock Holmes']||0) >= uniqueTeams, label: `${manualStatus['Sherlock Holmes']||0}/${uniqueTeams} teams` },
        drawing:         { done: (manualStatus['Drawing']||0) >= uniqueTeams, label: `${manualStatus['Drawing']||0}/${uniqueTeams} teams` },
        final_podium:    { done: evaluated >= 24 && fizzDone >= totalAssign && MANUAL_EVENTS.every(ev => (manualStatus[ev]||0) >= uniqueTeams), label: 'All events complete' }
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/manual-scores ──────────────────────────────────────────────
// All manual event scores
app.get('/api/admin/manual-scores', async (req, res) => {
  try {
    const { data, error } = await supabase.from('manual_event_scores').select('*');
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, scores: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/team-auth/:teamCode', async (req, res) => {
  try {
    const teamCode = String(req.params.teamCode || '').trim();

    if (!teamCode) {
      return res.status(400).json({ success: false, message: 'Team code is required.' });
    }

    const { data: teamData, error: teamError } = await supabase
      .from('teams')
      .select('*')
      .eq('team_code', teamCode)
      .single();

    if (teamError || !teamData) {
      return res.status(404).json({ success: false, message: 'Team not found.' });
    }

    const { data: participants, error: participantError } = await supabase
      .from('participants')
      .select('id, team_id, participant_name, shuffle_group, player_role')
      .eq('team_id', teamData.id);

    if (participantError) {
      return res.status(500).json({ success: false, message: participantError.message });
    }

    return res.status(200).json({
      success: true,
      team: {
        id: teamData.id,
        team_name: teamData.team_name,
        team_code: teamData.team_code
      },
      participants: participants || []
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Team authentication failed.' });
  }
});

app.post('/api/main-event-submit', async (req, res) => {
  try {
    const team_code = String(req.body?.team_code || '').trim();
    const participant_name = String(req.body?.participant_name || '').trim();
    const task_name = String(req.body?.task_name || '').trim();
    const github_link = normalizeGitHubUrl(req.body?.github_link);
    const elapsed_time = String(req.body?.elapsed_time || '').trim();

    if (!team_code || !participant_name || !task_name || !github_link || !elapsed_time) {
      return res.status(400).json({
        success: false,
        message: 'team_code, participant_name, task_name, github_link, and elapsed_time are required.'
      });
    }

    if (!validGitHubUrl(github_link)) {
      return res.status(400).json({
        success: false,
        message: 'Valid GitHub repository URL is required.'
      });
    }

    const { data: teamData, error: teamError } = await supabase
      .from('teams')
      .select('id')
      .eq('team_code', team_code)
      .single();

    if (teamError || !teamData) {
      return res.status(404).json({ success: false, message: 'Invalid team code.' });
    }

    const { data, error } = await supabase
      .from('main_event')
      .insert([
        {
          team_id: teamData.id,
          participant_name,
          task_name,
          github_link,
          elapsed_time,
          submitted_at: new Date().toISOString()
        }
      ])
      .select();

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.status(201).json({ success: true, data: data[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Main event submission failed.' });
  }
});

app.get('/api/test', async (req, res) => {
  try {
    const { data, error } = await supabase.from('teams').select('*');

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.status(200).json({ success: true, teams: data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch teams.' });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'Asthra Imposter Backend Running 🚀' });
});

app.post('/submit-main', async (req, res) => {
  try {
    const participant_name = String(req.body?.participant_name || '').trim();
    const task_name = String(req.body?.task_name || '').trim();
    const github_link = normalizeGitHubUrl(req.body?.github_link);

    if (!participant_name || !task_name || !github_link || !validGitHubUrl(github_link)) {
      return res.status(400).json({
        success: false,
        message: 'Valid participant_name, task_name, and GitHub repository URL are required.'
      });
    }

    const payload = {
      participant_name,
      task_name,
      github_link,
      submitted_time: new Date().toISOString(),
      status: 'Pending AI'
    };

    const { data, error } = await supabase
      .from('submissions_main')
      .insert([payload])
      .select();

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.status(201).json({ success: true, data: data[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Submission failed' });
  }
});

app.post('/submit-fizzbuzz', async (req, res) => {
  try {
    const participant_name = String(req.body?.participant_name || '').trim();
    const fizz_output = String(req.body?.fizz_output || '').trim();

    if (!participant_name || !fizz_output) {
      return res.status(400).json({
        success: false,
        message: 'participant_name and fizz_output are required.'
      });
    }

    const payload = {
      participant_name,
      fizz_output,
      submitted_time: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('submissions_fizzbuzz')
      .insert([payload])
      .select();

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.status(201).json({ success: true, data: data[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'FizzBuzz submission failed' });
  }
});

app.post('/submit-codeimposter', async (req, res) => {
  try {
    const team_name = String(req.body?.team_name || '').trim();

    if (!team_name) {
      return res.status(400).json({
        success: false,
        message: 'team_name is required.'
      });
    }

    const payload = {
      team_name,
      submitted_time: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('submissions_codeimposter')
      .insert([payload])
      .select();

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.status(201).json({ success: true, data: data[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Code Imposter submission failed' });
  }
});

app.get('/submissions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('submissions_main')
      .select('*')
      .order('submitted_time', { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch submissions' });
  }
});

app.get('/leaderboard', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('submissions_main')
      .select('participant_name, task_name, total_score, status')
      .order('total_score', { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch leaderboard' });
  }
});

app.post('/score/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: submissionData, error: fetchError } = await supabase
      .from('submissions_main')
      .select('github_link')
      .eq('id', id)
      .single();

    if (fetchError || !submissionData?.github_link) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found or missing github_link.'
      });
    }

    const scoreResult = await scoreRepository(submissionData.github_link);

    const totalScore = Number(scoreResult.total_score || 0);

    const { data, error } = await supabase
      .from('submissions_main')
      .update({
        ui_score: Number(scoreResult.ui_score || 0),
        logic_score: Number(scoreResult.logic_score || 0),
        creativity_score: Number(scoreResult.creativity_score || 0),
        imposter_score: Number(scoreResult.imposter_score || 0),
        total_score: totalScore,
        ai_feedback: String(scoreResult.feedback || ''),
        status: 'Evaluated'
      })
      .eq('id', id)
      .select();

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.status(200).json({ success: true, data: data[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Scoring failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 6 — EVENT TIMER SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/timer/:eventName — legacy single-timer lookup (uses event_key now)
app.get('/api/timer/:eventName', async (req, res) => {
  try {
    const key = resolveEventKey(decodeURIComponent(req.params.eventName || '').trim());
    const { data, error } = await supabase
      .from('event_timers').select('*').eq('event_key', key).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data)  return res.status(404).json({ success: false, message: 'Timer not found: ' + key });
    const norm = normaliseTimer(data);
    return res.status(200).json({ success: true, timer: norm });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/timers — legacy alias, delegates to new logic
app.get('/api/timers', async (req, res) => {
  try {
    const { data, error } = await supabase.from('event_timers').select('*').order('event_key');
    if (error) return res.status(500).json({ success: false, message: error.message });
    const timers = (data || []).map(normaliseTimer);
    return res.status(200).json({ success: true, timers });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// Legacy computeRemaining — delegates to new function
function computeRemaining(t) {
  return computeRemainingV2(t);
}

// Legacy /api/admin/timer/:eventName/* — all delegate to event_key-based logic
app.post('/api/admin/timer/:eventName/start', async (req, res) => {
  req.body = req.body || {};
  req.body.eventKey = resolveEventKey(decodeURIComponent(req.params.eventName).trim());
  return (await fetch || require('http')) && res.status(200); // redirect internally
});

// Simpler approach: just re-use the new handlers inline
['start','pause','resume','reset'].forEach(action => {
  app.post('/api/admin/timer/:eventName/'+action, async (req, res) => {
    try {
      const key = resolveEventKey(decodeURIComponent(req.params.eventName || '').trim());
      const { data: t } = await supabase.from('event_timers').select('*').eq('event_key', key).maybeSingle();
      if (!t) return res.status(404).json({ success: false, message: 'Timer not found: ' + key });

      let updatePayload = {};
      if (action === 'start') {
        if (t.status === 'running') return res.status(400).json({ success: false, message: 'Already running.' });
        const fullSecs = getFullSecs(t, 15);
        updatePayload = { status: 'running', started_at: new Date().toISOString(), paused_at: null, remaining_seconds: fullSecs };
      } else if (action === 'pause') {
        if (t.status !== 'running') return res.status(400).json({ success: false, message: 'Not running.' });
        const runningFor = Math.floor((Date.now() - new Date(t.started_at).getTime()) / 1000);
        const base       = (t.remaining_seconds != null && t.remaining_seconds > 0) ? t.remaining_seconds : getFullSecs(t, 15);
        const remaining  = Math.max(0, base - runningFor);
        updatePayload = { status: 'paused', paused_at: new Date().toISOString(), started_at: null, remaining_seconds: remaining };
      } else if (action === 'resume') {
        if (t.status !== 'paused') return res.status(400).json({ success: false, message: 'Not paused.' });
        updatePayload = { status: 'running', started_at: new Date().toISOString(), paused_at: null };
      } else if (action === 'reset') {
        const fullSecs = getFullSecs(t, 15);
        updatePayload = { status: 'idle', started_at: null, paused_at: null, remaining_seconds: fullSecs };
      }

      const { error } = await supabase.from('event_timers').update(updatePayload).eq('event_key', key);
      if (error) return res.status(500).json({ success: false, message: error.message });
      return res.status(200).json({ success: true, message: 'Timer ' + action + 'ed.', status: updatePayload.status });
    } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 8 — FIZZBUZZ GROUP SUBMISSION
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/fizzbuzz/status/:participantId — participant's group FizzBuzz info
app.get('/api/fizzbuzz/status/:participantId', async (req, res) => {
  try {
    const participantId = String(req.params.participantId || '').trim();

    // Get participant's assignment to find their group + role
    const { data: assignment, error: aErr } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, shuffled_group, is_imposter, fizzbuzz_locked')
      .eq('participant_id', participantId)
      .maybeSingle();

    if (aErr)        return res.status(500).json({ success: false, message: aErr.message });
    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found.' });

    // Check if group has already submitted (check both tables)
    let groupSub = null;
    const { data: sub1 } = await supabase
      .from('fizzbuzz_submissions_v2')
      .select('shuffled_group, submitted_by, submitted_at, is_correct, repo_url')
      .eq('shuffled_group', assignment.shuffled_group)
      .maybeSingle();
    if (sub1) {
      groupSub = sub1;
    } else {
      const { data: sub2 } = await supabase
        .from('fizzbuzz_submissions')
        .select('id, submitted_by, submitted_at, is_correct')
        .eq('shuffled_group', assignment.shuffled_group)
        .maybeSingle();
      groupSub = sub2 || null;
    }

    // Get FizzBuzz timer
    const { data: timer } = await supabase
      .from('event_timers')
      .select('*')
      .eq('event_key', 'fizzbuzz')
      .maybeSingle();

    const timerActive = timer && (timer.status === 'running' || timer.status === 'paused');
    const remaining   = timer ? computeRemainingV2(timer) : 0;

    // Secret rule only for Imposter
    const secretRule = assignment.is_imposter
      ? 'CLASSIFIED MISSION: When the number is divisible by both 3 and 5, convince the team to print the NUMBER ITSELF instead of "FizzBuzz". Do not reveal this to anyone.'
      : null;

    return res.status(200).json({
      success:        true,
      shuffled_group: assignment.shuffled_group,
      is_imposter:    assignment.is_imposter,
      secret_rule:    secretRule,
      group_submitted: !!groupSub,
      group_submission: groupSub ? { submitted_by: groupSub.submitted_by, submitted_at: groupSub.submitted_at } : null,
      fizzbuzz_locked: assignment.fizzbuzz_locked || !!groupSub,
      timer_active:   timerActive,
      timer_status:   timer?.status || 'idle',
      remaining_secs: remaining
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/fizzbuzz/submit — one submission per shuffled group
app.post('/api/fizzbuzz/submit', async (req, res) => {
  try {
    const participant_id = String(req.body?.participant_id || '').trim();
    const fizz_output    = String(req.body?.fizz_output    || '').trim();

    if (!participant_id || !fizz_output) {
      return res.status(400).json({ success: false, message: 'participant_id and fizz_output are required.' });
    }

    // Get participant's assignment
    const { data: assignment, error: aErr } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, shuffled_group, is_imposter, fizzbuzz_locked')
      .eq('participant_id', participant_id)
      .maybeSingle();

    if (aErr)        return res.status(500).json({ success: false, message: aErr.message });
    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found.' });

    // Check if group already submitted
    const { data: existing } = await supabase
      .from('fizzbuzz_submissions')
      .select('id, shuffled_group')
      .eq('shuffled_group', assignment.shuffled_group)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Your group has already submitted. Only one submission allowed per group.'
      });
    }

    // Check timer — submissions only allowed while timer is running or paused (not idle/finished)
    const { data: timer } = await supabase
      .from('event_timers')
      .select('status')
      .eq('event_key', 'fizzbuzz')
      .maybeSingle();

    if (timer && timer.status === 'finished') {
      return res.status(403).json({ success: false, message: 'FizzBuzz round has ended. No more submissions.' });
    }

    // Check if output looks sabotaged (number where FizzBuzz expected — simple heuristic)
    // Full scoring is done by admin; just flag for review
    const lines = fizz_output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    // Check line 15 (1-indexed) — should be 'FizzBuzz', sabotaged would be '15'
    const line15 = lines[14] || '';
    const imposterSabotaged = assignment.is_imposter && /^15$/.test(line15);

    // Insert group submission
    const { error: insErr } = await supabase
      .from('fizzbuzz_submissions')
      .insert({
        shuffled_group:     assignment.shuffled_group,
        submitted_by:       assignment.participant_name,
        participant_id:     participant_id,
        fizz_output,
        imposter_sabotaged: imposterSabotaged
      });

    if (insErr) return res.status(500).json({ success: false, message: insErr.message });

    // Lock all 4 members of the group
    await supabase
      .from('main_event_assignments')
      .update({ fizzbuzz_locked: true })
      .eq('shuffled_group', assignment.shuffled_group);

    return res.status(200).json({
      success:       true,
      message:       'FizzBuzz submission recorded for ' + assignment.shuffled_group + '.',
      submitted_by:  assignment.participant_name,
      shuffled_group: assignment.shuffled_group
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 9 — FIZZBUZZ SCORING
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/admin/fizzbuzz/score — admin marks a group correct/incorrect + apply scoring
app.post('/api/admin/fizzbuzz/score', async (req, res) => {
  try {
    const { shuffled_group, is_correct } = req.body;
    if (!shuffled_group || is_correct === undefined) {
      return res.status(400).json({ success: false, message: 'shuffled_group and is_correct are required.' });
    }

    // Get the submission to check imposter sabotage
    const { data: sub } = await supabase
      .from('fizzbuzz_submissions')
      .select('*')
      .eq('shuffled_group', shuffled_group)
      .maybeSingle();

    if (!sub) return res.status(404).json({ success: false, message: 'No submission found for this group.' });

    // Mark submission
    await supabase.from('fizzbuzz_submissions')
      .update({ is_correct })
      .eq('shuffled_group', shuffled_group);

    // Get all submissions ordered by time for speed bonus
    const { data: allSubs } = await supabase
      .from('fizzbuzz_submissions')
      .select('shuffled_group, submitted_at')
      .order('submitted_at', { ascending: true });

    // Speed bonus: 1st → +5, 2nd → +5, rest → +2
    const speedBonusMap = {};
    (allSubs || []).forEach((s, idx) => {
      speedBonusMap[s.shuffled_group] = idx < 2 ? 5 : 2;
    });

    // Determine scores for this group
    const teamScore    = is_correct ? 20 : 0;
    const speedBonus   = speedBonusMap[shuffled_group] || 2;
    const imposterSab  = sub.imposter_sabotaged && !is_correct; // sabotage counts only if output is wrong

    // Get all participants in this group
    const { data: members } = await supabase
      .from('main_event_assignments')
      .select('participant_id, is_imposter')
      .eq('shuffled_group', shuffled_group);

    for (const member of (members || [])) {
      const impBonus = (imposterSab && member.is_imposter) ? 10 : 0;
      const memberTeamScore = imposterSab ? 0 : teamScore;
      const total = memberTeamScore + speedBonus + impBonus;

      await supabase.from('main_event_assignments').update({
        fizzbuzz_team_score:  memberTeamScore,
        fizzbuzz_speed_bonus: speedBonus,
        imposter_bonus:       impBonus,
        fizzbuzz_score:       total
      }).eq('participant_id', member.participant_id);
    }

    return res.status(200).json({ success: true, message: 'FizzBuzz scores applied for ' + shuffled_group });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/fizzbuzz/submissions — all group FizzBuzz submissions for admin dashboard
app.get('/api/admin/fizzbuzz/submissions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('fizzbuzz_submissions')
      .select('*')
      .order('submitted_at', { ascending: true });
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, submissions: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 12 — INDIVIDUAL SCORE SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/my-scores/:participantId — participant sees only their own scores
app.get('/api/my-scores/:participantId', async (req, res) => {
  try {
    const participantId = String(req.params.participantId || '').trim();
    const { data, error } = await supabase
      .from('main_event_assignments')
      .select('participant_name, main_event_score, fizzbuzz_score, fizzbuzz_team_score, fizzbuzz_speed_bonus, imposter_bonus, ai_score')
      .eq('participant_id', participantId)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data)  return res.status(404).json({ success: false, message: 'Not found.' });

    const mainEvent  = Number(data.main_event_score || 0);
    const fizzbuzz   = Number(data.fizzbuzz_score    || 0);
    const impBonus   = Number(data.imposter_bonus    || 0);
    const total      = mainEvent + fizzbuzz + impBonus;

    return res.status(200).json({
      success: true,
      scores: {
        participant_name:    data.participant_name,
        main_event_score:    mainEvent,
        fizzbuzz_score:      fizzbuzz,
        fizzbuzz_team_score: Number(data.fizzbuzz_team_score  || 0),
        fizzbuzz_speed_bonus:Number(data.fizzbuzz_speed_bonus || 0),
        imposter_bonus:      impBonus,
        total_individual:    total
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED TIMER ROUTES — uses real event_timers table
// Real schema: event_key TEXT PK, event_name TEXT, duration_minutes INTEGER,
//              started_at TIMESTAMPTZ, paused_at TIMESTAMPTZ,
//              remaining_seconds INTEGER, status TEXT
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: get full duration in seconds from a timer row (supports both column schemas)
function getFullSecs(t, defaultMins) {
  if (t.duration_minutes != null && t.duration_minutes > 0) return t.duration_minutes * 60;
  if (t.duration_secs    != null && t.duration_secs    > 0) return t.duration_secs;
  return (defaultMins || 15) * 60;
}
// Map event_key aliases → event_key values in the real table
const EVENT_KEY_MAP = {
  'main_event':    'main_event',
  'fizzbuzz':      'fizzbuzz',
  'code_imposter': 'code_imposter',
  'sherlock':      'sherlock',
  // also accept display names
  'Main Event':      'main_event',
  'FizzBuzz':        'fizzbuzz',
  'Code Imposter':   'code_imposter',
  'Sherlock Holmes': 'sherlock'
};

function resolveEventKey(input) {
  if (!input) return null;
  return EVENT_KEY_MAP[input] || input.toLowerCase().replace(/\s+/g, '_');
}

// Compute remaining_seconds from DB row (handles running timers live)
// Supports both schema variants:
//   - event_key table: duration_minutes, remaining_seconds
//   - legacy table: duration_secs, elapsed_secs
function computeRemainingV2(t) {
  if (!t) return 0;
  // Support both duration_minutes and duration_secs column names
  const fullSecs = t.duration_minutes != null
    ? (t.duration_minutes * 60)
    : (t.duration_secs != null ? t.duration_secs : 900);  // fallback 15 min

  if (t.status === 'finished') return 0;

  if (t.status === 'running' && t.started_at) {
    const runningFor = Math.floor((Date.now() - new Date(t.started_at).getTime()) / 1000);
    // remaining_seconds in DB = value at last start/resume point
    const stored = t.remaining_seconds != null ? t.remaining_seconds : fullSecs;
    // Guard: if stored is 0 or negative, return full duration (prevents instant-finish on first start)
    const base = stored > 0 ? stored : fullSecs;
    return Math.max(0, base - runningFor);
  }

  // paused / idle: return stored remaining (or full if never set)
  // paused / idle / stopped / waiting
if (['paused', 'idle', 'stopped', 'waiting'].includes(t.status)) {
  if (t.remaining_seconds != null && t.remaining_seconds > 0) {
    return t.remaining_seconds;
  }
  return fullSecs;
}
}

// Normalise a DB row to a consistent shape for the frontend
function normaliseTimer(t) {
  const remaining = computeRemainingV2(t);
  return {
    event_key:         t.event_key,
    event_name:        t.event_name || t.event_key,
    duration_minutes:  t.duration_minutes,
    duration_secs:     getFullSecs(t, 15),  // compat alias
    started_at:        t.started_at,
    paused_at:         t.paused_at,
    remaining_seconds: remaining,
    remaining_secs:    remaining,                        // compat alias
    status:            t.status || 'idle'
  };
}

// ── GET /api/event-timers ─────────────────────────────────────────────────────
app.get('/api/event-timers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('event_timers')
      .select('*')
      .order('event_key');   // event_key is the PK — safe to order by
    if (error) return res.status(500).json({ success: false, message: error.message });
    const timers = (data || []).map(normaliseTimer);
    return res.status(200).json({ success: true, timers });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/fizzbuzz/toggle ──────────────────────────────────────────────────
app.get('/api/fizzbuzz/toggle', async (req, res) => {
  try {
    const { data } = await supabase.from('event_timers').select('*')
      .eq('event_key', 'fizzbuzz').maybeSingle();
    if (!data) return res.status(200).json({ success: true, fizzbuzz_open: false, status: 'idle', remaining_seconds: 1200 });
    const norm = normaliseTimer(data);
    const open = norm.status === 'running' || norm.status === 'paused';
    return res.status(200).json({ success: true, fizzbuzz_open: open, status: norm.status, remaining_seconds: norm.remaining_seconds });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/fizzbuzz/toggle ───────────────────────────────────────────
app.post('/api/admin/fizzbuzz/toggle', async (req, res) => {
  try {
    const { action } = req.body;
    if (!action) return res.status(400).json({ success: false, message: 'action required: "on" or "off"' });

    const { data: t } = await supabase.from('event_timers').select('*')
      .eq('event_key', 'fizzbuzz').maybeSingle();
    if (!t) return res.status(404).json({ success: false, message: 'FizzBuzz timer not found.' });

    const fullSecs = getFullSecs(t, 15);
    if (action === 'on') {
      const { error } = await supabase.from('event_timers').update({
        status: 'running', started_at: new Date().toISOString(),
        paused_at: null, remaining_seconds: fullSecs
      }).eq('event_key', 'fizzbuzz');
      if (error) return res.status(500).json({ success: false, message: error.message });
      return res.status(200).json({ success: true, fizzbuzz_open: true, status: 'running', remaining_seconds: fullSecs });
    } else {
      const { error } = await supabase.from('event_timers').update({
        status: 'idle', started_at: null, paused_at: null, remaining_seconds: fullSecs
      }).eq('event_key', 'fizzbuzz');
      if (error) return res.status(500).json({ success: false, message: error.message });
      return res.status(200).json({ success: true, fizzbuzz_open: false, status: 'idle', remaining_seconds: fullSecs });
    }
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/event/start ───────────────────────────────────────────
app.post('/api/event/start', async (req, res) => {
  try {
    const eventKey = resolveEventKey(String(req.body?.eventKey || '').trim());

    if (!eventKey) {
      return res.status(400).json({
        success: false,
        message: 'eventKey is required.'
      });
    }

    const { data: t, error: fetchError } = await supabase
      .from('event_timers')
      .select('*')
      .eq('event_key', eventKey)
      .single();

    if (fetchError || !t) {
      return res.status(404).json({
        success: false,
        message: `Timer not found: ${eventKey}`
      });
    }

    const fullSecs = getFullSecs(t, 15);

    const { error } = await supabase
      .from('event_timers')
      .update({
        status: 'running',
        started_at: new Date().toISOString(),
        paused_at: null,
        remaining_seconds: fullSecs,     // Reset timer to full duration
        duration_seconds: fullSecs       // Keep DB duration in sync
      })
      .eq('event_key', eventKey);

    if (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }

    return res.json({
      success: true,
      status: 'running',
      remaining_seconds: fullSecs
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

// ── POST /api/event/pause ─────────────────────────────────────────────────────
app.post('/api/event/pause', async (req, res) => {
  try {
    const eventKey = resolveEventKey(String(req.body?.eventKey || '').trim());
    const { data: t } = await supabase.from('event_timers').select('*').eq('event_key', eventKey).maybeSingle();
    if (!t || t.status !== 'running') return res.status(400).json({ success: false, message: 'Timer is not running.' });

    const runningFor = Math.floor((Date.now() - new Date(t.started_at).getTime()) / 1000);
    const remaining  = Math.max(0, (t.remaining_seconds || 0) - runningFor);

    const { error } = await supabase.from('event_timers').update({
      status: 'paused', paused_at: new Date().toISOString(),
      started_at: null, remaining_seconds: remaining
    }).eq('event_key', eventKey);
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, status: 'paused', remaining_seconds: remaining });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/event/resume ────────────────────────────────────────────────────
app.post('/api/event/resume', async (req, res) => {
  try {
    const eventKey = resolveEventKey(String(req.body?.eventKey || '').trim());
    const { data: t } = await supabase.from('event_timers').select('*').eq('event_key', eventKey).maybeSingle();
    if (!t || t.status !== 'paused') return res.status(400).json({ success: false, message: 'Timer is not paused.' });

    const { error } = await supabase.from('event_timers').update({
      status: 'running', started_at: new Date().toISOString(), paused_at: null
    }).eq('event_key', eventKey);
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, status: 'running', remaining_seconds: t.remaining_seconds });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/event/reset ─────────────────────────────────────────────────────
app.post('/api/event/reset', async (req, res) => {
  try {
    const eventKey = resolveEventKey(String(req.body?.eventKey || '').trim());
    const { data: t } = await supabase.from('event_timers').select('duration_minutes').eq('event_key', eventKey).maybeSingle();
    if (!t) return res.status(404).json({ success: false, message: 'Timer not found.' });

    const fullSecs = getFullSecs(t, 15);
    const { error } = await supabase.from('event_timers').update({
      status: 'idle', started_at: null, paused_at: null, remaining_seconds: fullSecs
    }).eq('event_key', eventKey);
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, status: 'idle', remaining_seconds: fullSecs });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/event/finish ────────────────────────────────────────────────────
// Called when countdown reaches 0 (from client tick)
app.post('/api/event/finish', async (req, res) => {
  try {
    const eventKey = resolveEventKey(String(req.body?.eventKey || '').trim());
    const { error } = await supabase.from('event_timers').update({
      status: 'finished', remaining_seconds: 0, started_at: null
    }).eq('event_key', eventKey);
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, status: 'finished', remaining_seconds: 0 });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/event/tick ──────────────────────────────────────────────────────
// Persist current remaining_seconds without changing status or started_at.
// Called every 10s by the client countdown to keep DB in sync for page refreshes.
app.post('/api/event/tick', async (req, res) => {
  try {
    const eventKey         = resolveEventKey(String(req.body?.eventKey || '').trim());
    const remaining_seconds = Number(req.body?.remaining_seconds);
    if (!eventKey) return res.status(400).json({ success: false, message: 'eventKey required.' });
    if (isNaN(remaining_seconds)) return res.status(400).json({ success: false, message: 'remaining_seconds required.' });

    // Only update if timer is still running (don't overwrite a paused/finished state)
    const { error } = await supabase.from('event_timers')
      .update({ remaining_seconds: Math.max(0, remaining_seconds) })
      .eq('event_key', eventKey)
      .eq('status', 'running');   // guard: only update running timers

    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/main-event/unlock ───────────────────────────────────────────────
app.post('/api/main-event/unlock', async (req, res) => {
  try {
    const participantId = String(req.body?.participantId || req.body?.participant_id || '').trim();
    if (!participantId) return res.status(400).json({ success: false, message: 'participantId is required.' });

    const { error } = await supabase
      .from('main_event_assignments')
      .update({
        github_repo:       null,
        github_repo_url:   null,
        github_owner:      null,
        github_repo_name:  null,
        github_branch:     null,
        submitted_at:      null,
        submission_locked: false,
        submission_status: 'Pending',
        evaluation_status: 'Pending',
        ai_score:          null,
        ai_feedback:       null
      })
      .eq('participant_id', participantId);

    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, message: 'Submission unlocked.' });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/fizzbuzz/group-status/:group ─────────────────────────────────────
// Returns whether a shuffled group has submitted (for FizzBuzz page locking)
app.get('/api/fizzbuzz/group-status/:group', async (req, res) => {
  try {
    const group = decodeURIComponent(req.params.group || '').trim();
    const { data } = await supabase
      .from('fizzbuzz_submissions_v2')
      .select('shuffled_group, submitted_by, submitted_at, repo_url, status')
      .eq('shuffled_group', group)
      .maybeSingle();
    return res.status(200).json({ success: true, submitted: !!data, submission: data || null });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/fizzbuzz/submit-v2 ──────────────────────────────────────────────
// FizzBuzz group submission — stores code + language, not GitHub repo
app.post('/api/fizzbuzz/submit-v2', async (req, res) => {
  try {
    const participant_id = String(req.body?.participant_id || '').trim();
    const fizz_output    = String(req.body?.fizz_output    || req.body?.code || '').trim();
    const language       = String(req.body?.language       || 'Unknown').trim();

    if (!participant_id) return res.status(400).json({ success: false, message: 'participant_id is required.' });
    if (!fizz_output)    return res.status(400).json({ success: false, message: 'Code/output is required.' });

    const { data: assignment } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, shuffled_group, is_imposter, fizzbuzz_locked')
      .eq('participant_id', participant_id)
      .maybeSingle();

    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found.' });

    // Check if group already submitted
    const { data: existing } = await supabase
      .from('fizzbuzz_submissions_v2')
      .select('shuffled_group, submitted_by')
      .eq('shuffled_group', assignment.shuffled_group)
      .maybeSingle();

    if (existing) return res.status(409).json({
      success: false,
      message: `Already submitted by ${existing.submitted_by}.`
    });

    // Check timer — use real event_timers table
    const { data: timer } = await supabase
      .from('event_timers')
      .select('status')
      .eq('event_key', 'fizzbuzz')
      .maybeSingle();
    if (timer && timer.status === 'finished') {
      return res.status(403).json({ success: false, message: 'FizzBuzz round has ended.' });
    }

    // Detect imposter sabotage heuristic
    const lines = fizz_output.split('\n').map(l => l.trim()).filter(l => l);
    const imposterSabotaged = assignment.is_imposter && (lines[14] === '15' || lines[14] === '15.0');

    // Insert submission with language field
    const { error: insErr } = await supabase.from('fizzbuzz_submissions_v2').insert({
      shuffled_group:     assignment.shuffled_group,
      submitted_by:       assignment.participant_name,
      participant_id,
      fizz_output,
      language,
      repo_url:           null,
      imposter_sabotaged: imposterSabotaged
    });

    if (insErr) return res.status(500).json({ success: false, message: insErr.message });

    // Lock all 4 members of the group
    await supabase.from('main_event_assignments')
      .update({ fizzbuzz_locked: true, fizzbuzz_completed: true })
      .eq('shuffled_group', assignment.shuffled_group);

    return res.status(200).json({
      success:        true,
      shuffled_group: assignment.shuffled_group,
      submitted_by:   assignment.participant_name,
      language
    });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/fizzbuzz/submissions-v2 ────────────────────────────────────
app.get('/api/admin/fizzbuzz/submissions-v2', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('fizzbuzz_submissions_v2')
      .select('*')
      .order('submitted_at', { ascending: true });
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, submissions: data || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/fizzbuzz/score-v2 ─────────────────────────────────────────
app.post('/api/admin/fizzbuzz/score-v2', async (req, res) => {
  try {
    const { shuffled_group, is_correct } = req.body;
    if (!shuffled_group || is_correct === undefined) {
      return res.status(400).json({ success: false, message: 'shuffled_group and is_correct are required.' });
    }

    const { data: sub } = await supabase
      .from('fizzbuzz_submissions_v2')
      .select('*')
      .eq('shuffled_group', shuffled_group)
      .maybeSingle();
    if (!sub) return res.status(404).json({ success: false, message: 'No submission found.' });

    await supabase.from('fizzbuzz_submissions_v2').update({ is_correct }).eq('shuffled_group', shuffled_group);

    // Speed bonus: order by submitted_at
    const { data: allSubs } = await supabase
      .from('fizzbuzz_submissions_v2')
      .select('shuffled_group, submitted_at')
      .order('submitted_at', { ascending: true });

    const speedMap = {};
    (allSubs || []).forEach((s, i) => { speedMap[s.shuffled_group] = i < 2 ? 5 : 2; });

    const teamScore  = is_correct ? 20 : 0;
    const speedBonus = speedMap[shuffled_group] || 2;
    const sabotaged  = sub.imposter_sabotaged && !is_correct;

    await supabase.from('fizzbuzz_submissions_v2')
      .update({ speed_bonus: speedBonus, imposter_bonus: sabotaged ? 10 : 0 })
      .eq('shuffled_group', shuffled_group);

    const { data: members } = await supabase
      .from('main_event_assignments')
      .select('participant_id, is_imposter, main_event_score')
      .eq('shuffled_group', shuffled_group);

    for (const m of (members || [])) {
      const impBonus  = (sabotaged && m.is_imposter) ? 10 : 0;
      const fzScore   = sabotaged ? 0 : (teamScore + speedBonus);
      const mainScore = Number(m.main_event_score || 0);
      await supabase.from('main_event_assignments').update({
        fizzbuzz_team_score:  sabotaged ? 0 : teamScore,
        fizzbuzz_speed_bonus: speedBonus,
        imposter_bonus:       impBonus,
        fizzbuzz_score:       fzScore + impBonus,
        total_individual_score: mainScore + fzScore + impBonus
      }).eq('participant_id', m.participant_id);
    }

    return res.status(200).json({ success: true, message: 'Scores applied for ' + shuffled_group });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/manual-score-v2 ──────────────────────────────────────────
// Saves manual event marks per team using the flat schema
app.post('/api/admin/manual-score-v2', async (req, res) => {
  try {
    const { original_team, event_name, marks } = req.body;
    if (!original_team || !event_name || marks === undefined) {
      return res.status(400).json({ success: false, message: 'original_team, event_name, marks required.' });
    }
    const col = event_name.toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
    const allowed = ['code_imposter', 'sherlock', 'drawing'];
    if (!allowed.includes(col)) {
      return res.status(400).json({ success: false, message: 'Invalid event_name.' });
    }
    const updateObj = {};
    updateObj[col] = Math.min(100, Math.max(0, Number(marks)));
    updateObj['updated_at'] = new Date().toISOString();

    const { error } = await supabase.from('manual_event_scores_v2')
      .upsert({ original_team, ...updateObj }, { onConflict: 'original_team' });

    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, message: 'Marks saved.' });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/manual-scores-v2 ──────────────────────────────────────────
app.get('/api/admin/manual-scores-v2', async (req, res) => {
  try {
    const { data, error } = await supabase.from('manual_event_scores_v2').select('*');
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, scores: data || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/podium-v2 ──────────────────────────────────────────────────
// Full podium using both individual scores and manual team marks
app.get('/api/admin/podium-v2', async (req, res) => {
  try {
    const [assignRes, manualRes] = await Promise.all([
      supabase.from('main_event_assignments').select('original_team, main_event_score, fizzbuzz_score, imposter_bonus, total_individual_score'),
      supabase.from('manual_event_scores_v2').select('*')
    ]);

    const teamMap = {};
    (assignRes.data || []).forEach(r => {
      const t = r.original_team || 'Unknown';
      if (!teamMap[t]) teamMap[t] = { team: t, main_event: 0, fizzbuzz: 0, manual: 0 };
      teamMap[t].main_event += Number(r.main_event_score || 0);
      teamMap[t].fizzbuzz   += Number(r.fizzbuzz_score   || 0);
    });

    (manualRes.data || []).forEach(r => {
      const t = r.original_team;
      if (!teamMap[t]) teamMap[t] = { team: t, main_event: 0, fizzbuzz: 0, manual: 0 };
      teamMap[t].manual += Number(r.code_imposter || 0) + Number(r.sherlock || 0) + Number(r.drawing || 0);
    });

    const podium = Object.values(teamMap)
      .map(t => ({ ...t, grand_total: t.main_event + t.fizzbuzz + t.manual }))
      .sort((a, b) => b.grand_total - a.grand_total);

    return res.status(200).json({ success: true, podium });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
