const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { attachScope } = require('../middleware/scope');

const router = express.Router();
router.use(requireAuth, attachScope);

router.get('/', async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;
  const { search, groupId, districtId, isRefugee, hasDisability } = req.query;

  const conditions = ['active_in_group = true'];
  const params = [];
  let idx = 1;

  if (!req.scope.unrestricted) {
    if (req.scope.groupIds.length === 0) {
      return res.json({ data: [], page, limit, total: 0 });
    }
    conditions.push(`farmer_group_id = ANY($${idx++})`);
    params.push(req.scope.groupIds);
  }
  if (groupId) {
    conditions.push(`farmer_group_id = $${idx++}`);
    params.push(groupId);
  }
  if (districtId) {
    conditions.push(`district_id = $${idx++}`);
    params.push(districtId);
  }
  if (isRefugee !== undefined) {
    conditions.push(`is_refugee = $${idx++}`);
    params.push(isRefugee === 'true');
  }
  if (hasDisability !== undefined) {
    conditions.push(`has_disability = $${idx++}`);
    params.push(hasDisability === 'true');
  }
  if (search) {
    conditions.push(`full_name ILIKE $${idx++}`);
    params.push(`%${search}%`);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  try {
    const countResult = await pool.query(`SELECT COUNT(*) FROM beneficiaries ${whereClause}`, params);
    const dataResult = await pool.query(
      `SELECT id, full_name, gender, date_of_birth, is_refugee, has_disability,
              district_id, farmer_group_id, phone, registered_at
       FROM beneficiaries ${whereClause}
       ORDER BY registered_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );

    res.json({
      data: dataResult.rows,
      page,
      limit,
      total: parseInt(countResult.rows[0].count, 10),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching beneficiaries' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM beneficiaries WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Beneficiary not found' });

    if (!req.scope.unrestricted && !req.scope.groupIds.includes(rows[0].farmer_group_id)) {
      return res.status(403).json({ error: 'You do not have access to this record' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching beneficiary' });
  }
});

router.post(
  '/',
  requireRole('agent', 'super_agent', 'program_officer', 'admin'),
  [body('fullName').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const b = req.body;

    if (!b.farmerGroupId && !b.farmerGroupName) {
      return res.status(400).json({ error: 'A farmer group is required' });
    }

    if (!req.scope.unrestricted && b.farmerGroupId && !req.scope.groupIds.includes(b.farmerGroupId)) {
      return res.status(403).json({ error: 'You cannot register beneficiaries into a group you do not manage' });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO beneficiaries (
          full_name, gender, date_of_birth, year_of_birth, phone,
          is_refugee, nin_or_refugee_number,
          district_id, subcounty_id, parish_id, village_id,
          subcounty_name, parish_name, village_name,
          farmer_group_id, project_supporting_profile, has_participated_before, joined_via_cso,
          has_mobile_phone, mobile_money_registered, has_bank_account, bank_name,
          is_vsla_or_group_member, vsla_name,
          next_of_kin_name, next_of_kin_phone,
          livelihood_category, enterprise_crop, enterprise_animal_rearing,
          enterprise_beekeeping, enterprise_poultry, enterprise_general_business, enterprise_other,
          has_disability, disability_prefer_not_to_tell, disability_legs_walking,
          disability_vision_eye, disability_arms_hands, disability_hearing_speaking, disability_mental,
          education_level,
          activity_school, activity_farming, activity_own_business, activity_employed,
          activity_volunteer_apprentice, activity_jobless, activity_household_work,
          has_land_access, has_capital_access,
          consent_share_with_third_party, photo_url,
          interviewer_name, interviewer_phone, registered_by, client_uuid,
          chairperson_name, chairperson_phone, group_type_selected, land_acres,
          photo_latitude, photo_longitude,
          group_village, group_parish, group_district_name, group_subcounty_name,
          group_agent_name, group_agent_phone,
          consent_form_signed,
          signature_url,
          synced_at
        ) VALUES (
          $1,$2,$3,$4,$5, $6,$7, $8,$9,$10,$11, $12,$13,$14,
          $15,$16,$17,$18,
          $19,$20,$21,$22, $23,$24,
          $25,$26,
          $27,$28,$29,$30,$31,$32,
          $33,$34,$35,$36,$37,$38,$39,
          $40,
          $41,$42,$43,$44,$45,$46,$47,
          $48,$49,
          $50,$51,
          $52,$53,$54,$55,$56,
          $57,$58,$59,$60,
          $61,$62,
          $63,$64,$65,$66,
          $67,$68,
          $69,
          $70, now()
        ) RETURNING *`,
        [
          b.fullName, b.gender || null, b.dateOfBirth || null, b.yearOfBirth || null, b.phone || null,
          b.isRefugee || false, b.ninOrRefugeeNumber || null,
          b.districtId || null, b.subcountyId || null, b.parishId || null, b.villageId || null,
          b.subcountyName || null, b.parishName || null, b.villageName || null,
          b.farmerGroupId || null, b.projectSupportingProfile || null, b.hasParticipatedBefore || false, b.joinedViaCso || null,
          b.hasMobilePhone || null, b.mobileMoneyRegistered || null, b.hasBankAccount || null, b.bankName || null,
          b.isVslaOrGroupMember || false, b.vslaName || null,
          b.nextOfKinName || null, b.nextOfKinPhone || null,
          b.livelihoodCategory || null, b.enterpriseCrop || false, b.enterpriseAnimalRearing || false,
          b.enterpriseBeekeeping || false, b.enterprisePoultry || false, b.enterpriseGeneralBusiness || false, b.enterpriseOther || null,
          b.hasDisability || false, b.disabilityPreferNotToTell || false, b.disabilityLegsWalking || false,
          b.disabilityVisionEye || false, b.disabilityArmsHands || false, b.disabilityHearingSpeaking || false, b.disabilityMental || false,
          b.educationLevel || null,
          b.activitySchool || false, b.activityFarming || false, b.activityOwnBusiness || false, b.activityEmployed || false,
          b.activityVolunteerApprentice || false, b.activityJobless || false, b.activityHouseholdWork || false,
          b.hasLandAccess || null, b.hasCapitalAccess || null,
          b.consentShareWithThirdParty || false, b.photoUrl || null,
          b.interviewerName || null, b.interviewerPhone || null, req.user.id, b.clientUuid || null,
          b.chairpersonName || null, b.chairpersonPhone || null, b.groupType || null, b.landAcres || null,
          b.photoLatitude || null, b.photoLongitude || null,
          b.groupVillage || null, b.groupParish || null, b.groupDistrictName || null, b.groupSubcountyName || null,
          b.groupAgentName || null, b.groupAgentPhone || null,
          b.consentFormSigned || false,
          b.signatureUrl || null,
        ]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(200).json({ message: 'Already synced' });
      }
      console.error(err);
      res.status(500).json({ error: 'Server error creating beneficiary' });
    }
  }
);

router.patch('/:id/remove-from-group', requireRole('super_agent', 'program_officer', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT farmer_group_id FROM beneficiaries WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Beneficiary not found' });

    if (!req.scope.unrestricted && !req.scope.groupIds.includes(rows[0].farmer_group_id)) {
      return res.status(403).json({ error: 'You do not have access to this record' });
    }

    await pool.query('UPDATE beneficiaries SET active_in_group = false WHERE id = $1', [req.params.id]);
    res.json({ message: 'Removed from group' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error removing beneficiary from group' });
  }
});

router.post('/sync', requireRole('super_agent', 'program_officer', 'admin'), async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: 'records must be an array' });

  const results = [];
  for (const record of records) {
    try {
      results.push({ clientUuid: record.clientUuid, status: 'queued_for_processing' });
    } catch (err) {
      results.push({ clientUuid: record.clientUuid, status: 'error', error: err.message });
    }
  }
  res.json({ results });
});

module.exports = router;