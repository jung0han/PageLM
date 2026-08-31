# QAI PageLM

The language and authority boundaries used by the QAI PageLM fork.

## Language

**사람 사용자**:
재직 여부와 조직 소속을 LDAP가 권위 있게 제공하는 QAI 사용자다. QAI 사용자 자체와 콘텐츠의 수명주기는 Authentik·SCIM의 인증 수명주기와 구분한다.
_Avoid_: 일반 계정, LDAP 계정, 직원 계정

**연동 사용자**:
사람 대신 다른 시스템의 작업을 수행하며 Authentik 서비스 계정 또는 명시적 QAI 예외로 분류된 QAI 사용자다. LDAP 미발견만으로 연동 사용자라고 추정하지 않는다.
_Avoid_: 공용 계정, 공유 계정, LDAP 미발견 사용자

**QAI 연동 예외**:
Authentik 서비스 계정으로 표현되지 않은 레거시 연동 사용자를 QAI가 명시적으로 분류한 애플리케이션 로컬 사용자 유형이다. 접근 권한이나 자격증명 레지스트리가 아니다.
_Avoid_: credential record, LDAP miss exception

**미분류 사용자**:
사람 사용자 또는 연동 사용자임을 권위 있는 원천에서 확인하지 못한 QAI 사용자다. 검토가 필요한 상태이며 퇴직이나 미사용의 증거가 아니다.
_Avoid_: 퇴직자, 미사용 계정, 연동 사용자 추정

**PageLM 학습 범위**:
한 PageLM chat이 원문 근거를 찾도록 사용자가 source bag에 추가한 공유 자료실과 해당 chat에 직접 올린 개인 자료의 집합이다. source bag이 비어 있으면 공유 자료 검색을 수행하지 않는다.
_Avoid_: runtime ACL inheritance, future descendant inclusion, implicit global scope

**공유 자료실**:
Archive Collection 하나의 현재 자료를 흡수한 재사용 PageLM search namespace의 사용자용 표현이다. 기존 parent 관계는 tree picker의 탐색·선택에만 사용하고 runtime 자료실 계층이나 ACL 상속을 만들지 않는다.
_Avoid_: Library domain, runtime hierarchy, vector-store provider

**학습 자료**:
Archive Record 하나의 제목·설명·원본 asset과 검색 chunk metadata를 한 자료처럼 보여주는 PageLM projection이다. 별도 Material 테이블·수명주기·API를 소유하지 않는다.
_Avoid_: Material entity, Record API, independent revision authority

**개인 chat 자료**:
PageLM 학습 사용자가 한 chat에 직접 올려 그 chat에서만 사용하는 자료다. 다른 chat이나 사용자에게 재사용되는 공유 자료실이 아니다.
_Avoid_: personal library, shared source, Archive migration target

**개인 학습 상태**:
한 인증 주체에게 귀속되는 PageLM 대화, 개인 chat 자료, chat별 source bag과 사용자 전역 Learning Bag이다. 이메일이나 표시 이름으로 소유권을 승계하지 않으며 공유 자료실이나 원문 권위가 아니다.
_Avoid_: shared workspace, email-owned content, Archive evidence

**PageLM 학습 사용자**:
권위 있게 사람 사용자로 확인되고 현재 active 상태인 개인 학습 상태의 주체다. 연동 사용자, QAI 연동 예외와 미분류 사용자는 PageLM의 대화형 학습 주체가 아니다.
_Avoid_: service account, integration user, unclassified user

**학습 파생물**:
PageLM assistant turn에서 만든 Notes, Flashcards, Quiz, ExamLab, Debate 또는 Podcast 같은 학습 표현이다. 원문이나 citation source가 아니며, 읽기·다운로드·stream 시 소유권과 그 turn이 의존한 공유 자료실의 현재 접근 권한을 다시 확인한다.
_Avoid_: source evidence, exact source-revision dependency, permanently owned copy
