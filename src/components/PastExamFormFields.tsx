"use client";

import { useEffect, useRef } from "react";
import { PicklistField } from "@/components/PicklistField";

type Props = {
  schoolName: string;
  onSchoolName: (v: string) => void;
  examDepartment: string;
  onExamDepartment: (v: string) => void;
  examSubject: string;
  onExamSubject: (v: string) => void;
  examPeriod: string;
  onExamPeriod: (v: string) => void;
};

export function PastExamFormFields({
  schoolName,
  onSchoolName,
  examDepartment,
  onExamDepartment,
  examSubject,
  onExamSubject,
  examPeriod,
  onExamPeriod,
}: Props) {
  const prevSchoolRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSchoolRef.current;
    prevSchoolRef.current = schoolName;
    if (prev === null) return;
    if (prev === schoolName) return;
    onExamDepartment("");
    onExamSubject("");
    onExamPeriod("");
  }, [schoolName, onExamDepartment, onExamSubject, onExamPeriod]);

  const prevDeptRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevDeptRef.current;
    prevDeptRef.current = examDepartment;
    if (prev === null) return;
    if (prev === examDepartment) return;
    onExamSubject("");
    onExamPeriod("");
  }, [examDepartment, onExamSubject, onExamPeriod]);

  const scope = schoolName.trim();
  const deptScope = examDepartment.trim();

  return (
    <div className="space-y-4 rounded-lg border border-sky-200 bg-sky-50/40 p-4">
      <p className="text-xs font-medium text-sky-950">
        過去問のメタ情報（任意）
      </p>
      <PicklistField
        category="school_name"
        label="学校名"
        id="past-exam-school"
        value={schoolName}
        onChange={onSchoolName}
        allowOther
      />
      <PicklistField
        category="department_name"
        label="学科名"
        id="past-exam-department"
        value={examDepartment}
        onChange={onExamDepartment}
        allowOther
        schoolFilterForOptions={scope || undefined}
        scopeSchoolWhenAdding={scope || undefined}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <PicklistField
          category="exam_subject"
          label="科目"
          id="exam-subject"
          value={examSubject}
          onChange={onExamSubject}
          allowOther
          schoolFilterForOptions={scope || undefined}
          scopeSchoolWhenAdding={scope || undefined}
          departmentFilterForOptions={deptScope || undefined}
          scopeDepartmentWhenAdding={deptScope || undefined}
        />
        <PicklistField
          category="exam_period"
          label="テストの時期"
          id="exam-period"
          value={examPeriod}
          onChange={onExamPeriod}
          allowOther
          schoolFilterForOptions={scope || undefined}
          scopeSchoolWhenAdding={scope || undefined}
          departmentFilterForOptions={deptScope || undefined}
          scopeDepartmentWhenAdding={deptScope || undefined}
        />
      </div>
    </div>
  );
}
