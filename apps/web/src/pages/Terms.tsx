// cSpell:ignore another's Llc's tortious
import { Helmet } from 'react-helmet';

import LegalContainer from '@/components/LegalContainer';
import { REFUND_DAYS, SUPPORT_EMAIL } from '@/config/plan';

import styles from './Terms.module.css';

export default function Terms() {
  return (
    <LegalContainer className={styles.root}>
      <Helmet>
        <title>Terms Of Service Agreement</title>
      </Helmet>

      <h1>TERMS OF SERVICE AGREEMENT</h1>

      <p>
        PLEASE READ THE FOLLOWING TERMS OF SERVICE AGREEMENT CAREFULLY. BY ACCESSING OR USING OUR SITES AND OUR
        SERVICES, YOU HEREBY AGREE TO BE BOUND BY THE TERMS AND ALL TERMS INCORPORATED HEREIN BY REFERENCE. IT IS THE
        RESPONSIBILITY OF YOU, THE USER, CUSTOMER, OR PROSPECTIVE CUSTOMER TO READ THE TERMS AND CONDITIONS BEFORE
        PROCEEDING TO USE THIS SITE. IF YOU DO NOT EXPRESSLY AGREE TO ALL OF THE TERMS AND CONDITIONS, THEN PLEASE DO
        NOT ACCESS OR USE OUR SITES OR OUR SERVICES. THIS TERMS OF SERVICE AGREEMENT IS EFFECTIVE AS OF 10/27/2026
      </p>

      <h4>ACCEPTANCE OF TERMS</h4>

      <p>
        The following Terms of Service Agreement (the "TOS") is a legally binding agreement that shall govern the
        relationship with our users and others which may interact or interface with MakeRocketGoNow LLC, also known as
        PushThat, and our affiliates, in association with the use of the website, which includes https://pushthat.link,
        (the "App") and its Services, which shall be defined below.
      </p>

      <h4>DESCRIPTION OF WEBSITE SERVICES OFFERED</h4>

      <p>The App is software as a service which has the following description:</p>

      <p>PushThat provides a service for sharing links and files between devices.</p>

      <p>
        Any and all visitors to our site, despite whether they are registered or not, shall be deemed as "users" of the
        herein contained Services provided for the purpose of this TOS. Once an individual register's for our Services,
        through the process of creating an account, the user shall then be considered a "member."
      </p>

      <p>
        The user and/or member acknowledges and agrees that the Services provided and made available through our website
        and applications are the sole property of MakeRocketGoNow LLC. At its discretion, MakeRocketGoNow LLC may offer
        additional website Services and/or products, or update, modify or revise any current content and Services, and
        this Agreement shall apply to any and all additional Services and/or products and any and all updated, modified
        or revised Services unless otherwise stipulated. MakeRocketGoNow LLC does hereby reserve the right to cancel and
        cease offering any of the aforementioned Services and/or products. You, as the end user and/or member,
        acknowledge, accept and agree that MakeRocketGoNow LLC shall not be held liable for any such updates,
        modifications, revisions, suspensions or discontinuance of any of our Services and/or products. Your continued
        use of the Services provided, after such posting of any updates, changes, and/or modifications shall constitute
        your acceptance of such updates, changes and/or modifications, and as such, frequent review of this Agreement
        and any and all applicable terms and policies should be made by you to ensure you are aware of all terms and
        policies currently in effect. Should you not agree to the updated, revised or modified terms, you must stop
        using the provided Services forthwith.
      </p>

      <p>
        Furthermore, the user and/or member understands, acknowledges and agrees that the Services offered shall be
        provided "AS IS" and as such MakeRocketGoNow LLC shall not assume any responsibility or obligation for the
        timeliness, missed delivery, deletion and/or any failure to store user content, communication or personalization
        settings.
      </p>

      <h4>PLANS AND PAYMENT</h4>

      <p>
        Every account starts on the free plan, with no card asked for. The free plan and the Pro plan each allow a
        number of link and file pushes a month, a largest file size, and a period after which a pushed file is deleted;
        the numbers, and the price of Pro, are the ones shown on our website and at checkout when you subscribe. Prices
        are in US dollars, and sales tax or VAT is added where it applies. We may change the limits of either plan, and
        will give subscribers at least 30 days' notice of a change to the price of Pro before the renewal it applies to.
      </p>

      <p>
        Our order process is conducted by Stripe, through its Managed Payments service. Stripe is the merchant of record
        for every order, under its Link name: it takes the payment, issues the receipt and handles tax, and its own
        buyer terms apply to the purchase alongside these.
      </p>

      <p>
        Pro is billed yearly and renews automatically each year, at the price then current, until you cancel it. You can
        cancel at any time, on the website, from Plan, then Manage billing. Cancelling stops the next renewal; the
        account keeps Pro until the end of the year already paid for, and then returns to the free plan. Nothing you
        have pushed is deleted because a plan ends: each file keeps the retention period of the plan the account was on
        when it was pushed.
      </p>

      <h4 id="refunds">REFUNDS</h4>

      <p>
        If Pro is not for you, ask for a refund within {REFUND_DAYS} days of any charge (the first year or a renewal)
        and you will get the whole of that charge back. No reason is needed. Write to {SUPPORT_EMAIL} from the address
        the account used, or ask Stripe directly through the support link in your receipt. A refunded plan is cancelled,
        so it does not renew. After {REFUND_DAYS} days a charge is not refunded, though cancelling still stops the next
        one. Where the law where you live gives you a longer right to cancel or to a refund, you have it regardless of
        this section.
      </p>

      <h4>REGISTRATION</h4>

      <p>
        To register and become a "member" of the App, you must be at least 18 years of age to enter into and form a
        legally binding contract. In addition, you must be in good standing and not an individual that has been
        previously barred from receiving 's Services under the laws and statutes of the United States or other
        applicable jurisdiction.
      </p>

      <p>
        When you register, we may collect information such as your name, and e-mail address. You can edit your account
        information at any time. Once you register with and sign in to our Services, you are no longer anonymous to us.
      </p>

      <h4>PRIVACY POLICY</h4>

      <p>
        Every member's registration data and various other personal information are strictly protected by the
        MakeRocketGoNow LLC Online Privacy Policy (see the full Privacy Policy at https://pushthat.link/privacy). As a
        member, you herein consent to the collection and use of the information provided, including the transfer of
        information within the United States and/or other countries for storage, processing or use by MakeRocketGoNow
        LLC and/or our subsidiaries and affiliates.
      </p>

      <h5>MEMBER ACCOUNT, USERNAME, PASSWORD AND SECURITY</h5>

      <p>
        When you set up an account, you are the sole authorized user of your account. You shall be responsible for
        maintaining the secrecy and confidentiality of your password and for all activities that transpire on or within
        your account. It is your responsibility for any act or omission of any user(s) that access your account
        information that, if undertaken by you, would be deemed a violation of the TOS. It shall be your responsibility
        to notify MakeRocketGoNow LLC immediately if you notice any unauthorized access or use of your account or
        password or any other breach of security. MakeRocketGoNow LLC shall not be held liable for any loss and/or
        damage arising from any failure to comply with this term and/or condition of the TOS.
      </p>

      <h5>END-TO-END ENCRYPTION AND YOUR RECOVERY KEY</h5>

      <p>
        The links and files you push, and their titles and names (“Push Content”), are end-to-end encrypted with a key
        made from your password, as described in the Privacy Policy and at https://pushthat.link/security. When you
        register, you are shown a recovery key, which is the only other way to unlock your Push Content. MakeRocketGoNow
        LLC never receives your recovery key, receives your password only in the cases described in the Privacy Policy,
        and cannot decrypt your Push Content (apart from pushes made before end-to-end encryption that are still stored
        as they were sent). You are solely responsible for keeping your password and your recovery key. If you reset
        your password without your recovery key, or lose both, the Push Content made before then cannot be recovered by
        you or by MakeRocketGoNow LLC, and MakeRocketGoNow LLC shall not be held liable for that loss.
      </p>

      <h4>CONDUCT</h4>

      <p>
        As a user or member of the App, you herein acknowledge, understand and agree that all information, text,
        software, data, photographs, music, video, messages, tags or any other content, whether it is publicly or
        privately posted and/or transmitted, is the expressed sole responsibility of the individual from whom the
        content originated. In short, this means that you are solely responsible for any and all content posted,
        uploaded, emailed, transmitted or otherwise made available by way of the Services, and as such, we do not
        guarantee the accuracy, integrity or quality of such content. It is expressly understood that by use of our
        Services, you may be exposed to content including, but not limited to, any errors or omissions in any content
        posted, and/or any loss or damage of any kind incurred as a result of the use of any content posted, emailed,
        transmitted or otherwise made available by .
      </p>

      <p>Furthermore, you herein agree not to make use of MakeRocketGoNow LLC's Services for the purpose of:</p>
      <ol>
        <li>
          uploading, posting, emailing, transmitting, or otherwise making available any content that shall be deemed
          unlawful, harmful, threatening, abusive, harassing, tortious, defamatory, vulgar, obscene, libelous, or
          invasive of another's privacy or which is hateful, and/or racially, ethnically, or otherwise objectionable;
        </li>
        <li>causing harm to minors in any manner whatsoever;</li>
        <li>
          impersonating any individual or entity, including, but not limited to, any officials, forum leaders, guides or
          hosts or falsely stating or otherwise misrepresenting any affiliation with an individual or entity;
        </li>
        <li>
          forging captions,headings or titles or otherwise offering any content that you personally have no right to
          pursuant to any law nor having any contractual or fiduciary relationship with;
        </li>
        <li>
          uploading, posting, emailing, transmitting or otherwise offering any such content that may infringe upon any
          patent, copyright, trademark, or any other proprietary or intellectual rights of any other party;
        </li>
        <li>
          uploading, posting, emailing, transmitting or otherwise offering any content that you do not personally have
          any right to offer pursuant to any law or in accordance with any contractual or fiduciary relationship;
        </li>
        <li>
          uploading, posting, emailing, transmitting, or otherwise offering any unsolicited or unauthorized advertising,
          promotional flyers, "junk mail," "spam," or any other form of solicitation, except in any such areas that may
          have been designated for such purpose;
        </li>
        <li>
          uploading, posting, emailing, transmitting, or other wise offering any source that may contain a software
          virus or other computer code, any files and/or programs which have been designed to interfere, destroy and/or
          limit the operation of any computer software, hardware, or telecommunication equipment;
        </li>
        <li>
          disrupting the normal flow of communication, or otherwise acting in any manner that would negatively affect
          other users' ability to participate in any real time interactions;
        </li>
        <li>
          interfering with or disrupting any MakeRocketGoNow LLC Services, servers and/or networks that may be connected
          or related to our website, including, but not limited to, the use of any device software and/or routine to
          bypass the robot exclusion headers;
        </li>
        <li>
          intentionally or unintentionally violating any local, state, federal, national or international law,
          including, but not limited to, rules, guidelines, and/or regulations decreed by the U.S. Securities and
          Exchange Commission, in addition to any rules of any nation or other securities exchange, that would include
          without limitation, the New York Stock Exchange, the American Stock Exchange, or the NASDAQ, and any
          regulations having the force of law;
        </li>
        <li>
          providing informational support or resources, concealing and/or disguising the character, location, and or
          source to any organization delegated by the United States government as a "foreign terrorist organization" in
          accordance to Section 219 of the Immigration Nationality Act;
        </li>
        <li>"stalking" or with the intent to otherwise harass another individual; and/or</li>
        <li>
          collecting or storing of any personal data relating to any other member or user in connection with the
          prohibited conduct and/or activities which have been set forth in the aforementioned paragraphs.
        </li>
      </ol>

      <p>
        MakeRocketGoNow LLC herein reserves the right to refuse and/or delete any content currently available through
        our Services. Because Push Content is end-to-end encrypted, MakeRocketGoNow LLC does not pre-screen or review
        it. In addition, we reserve the right to remove and/or delete any such content that would violate the TOS or
        which would otherwise be considered offensive to other visitors, users and/or members.
      </p>

      <p>
        MakeRocketGoNow LLC herein reserves the right to access, preserve and/or disclose member account information
        and/or content if it is requested to do so by law or in good faith belief that any such action is deemed
        reasonably necessary for:
      </p>
      <ol>
        <li>compliance with any legal process;</li>
        <li>enforcement of the TOS;</li>
        <li>
          responding to any claim that therein contained content is in violation of the rights of any third party;
        </li>
        <li>responding to requests for customer service; or</li>
        <li>
          protecting the rights, property or the personal safety of MakeRocketGoNow LLC, its visitors, users and
          members, including the general public.
        </li>
      </ol>

      <p>
        Push Content can be accessed, preserved and/or disclosed only in its encrypted form, which MakeRocketGoNow LLC
        cannot decrypt, apart from pushes made before end-to-end encryption that are still stored as they were sent, as
        described in the Privacy Policy.
      </p>

      <p>
        MakeRocketGoNow LLC herein reserves the right to include the use of security components that may permit digital
        information or material to be protected, and that such use of information and/or material is subject to usage
        guidelines and regulations established by MakeRocketGoNow LLC or any other content providers supplying content
        services to MakeRocketGoNow LLC. You are hereby prohibited from making any attempt to override or circumvent any
        of the embedded usage rules in our Services. Furthermore, unauthorized reproduction, publication, distribution,
        or exhibition of any information or materials supplied by our Services, despite whether done so in whole or in
        part, is expressly prohibited.
      </p>

      <h4>CAUTIONS FOR GLOBAL USE AND EXPORT AND IMPORT COMPLIANCE</h4>

      <p>
        Due to the global nature of the internet, through the use of our network you hereby agree to comply with all
        local rules relating to online conduct and that which is considered acceptable Content. Uploading, posting
        and/or transferring of software, technology and other technical data may be subject to the export and import
        laws of the United States and possibly other countries. Through the use of our network, you thus agree to comply
        with all applicable export and import laws, statutes and regulations, including, but not limited to, the Export
        Administration Regulations (http://www.access.gpo.gov/bis/ear/ear_data.html), as well as the sanctions control
        program of the United States (http://www.treasury.gov/resource- center/sanctions/Programs/Pages/Programs.aspx).
        Furthermore, you state and pledge that you:
      </p>
      <ol>
        <li>
          are not on the list of prohibited individuals which may be identified on any government export exclusion
          report ({'http://www.bis.doc.gov/complianceandenforcement/liststocheck.htm'}) nor a member of any other
          government which may be part of an export-prohibited country identified in applicable export and import laws
          and regulations;
        </li>
        <li>
          agree not to transfer any software, technology or any other technical data through the use of our network
          Services to any export-prohibited country;
        </li>
        <li>
          agree not to use our website network Services for any military, nuclear, missile, chemical or biological
          weaponry end uses that would be a violation of the U.S. export laws; and
        </li>
        <li>
          agree not to post,transfer nor upload any software, technology or any other technical data which would be in
          violation of the U.S. or other applicable export and/or import laws.
        </li>
      </ol>

      <h4>CONTRIBUTIONS TO COMPANY WEBSITE</h4>

      <p>
        MakeRocketGoNow LLC provides an area for our users and members to contribute feedback to our website. When you
        submit ideas, documents, suggestions and/or proposals ("Contributions") to our site, you acknowledge and agree
        that:
      </p>
      <ol>
        <li>your contributions do not contain any type of confidential or proprietary information;</li>
        <li>
          shall not be liable or under any obligation to ensure or maintain confidentiality, expressed or implied,
          related to any Contributions;
        </li>
        <li>
          shall be entitled to make use of and/or disclose any such Contributions in any such manner as they may see
          fit;
        </li>
        <li>the contributor's Contributions shall automatically become the sole property of; and</li>
        <li>
          is under no obligation to either compensate or provide any form of reimbursement in any manner or nature.
        </li>
      </ol>

      <h4>INDEMNITY</h4>

      <p>
        All users and/or members herein agree to insure and hold MakeRocketGoNow LLC, our subsidiaries, affiliates,
        agents, employees, officers, partners and/or licensors blameless or not liable for any claim or demand, which
        may include, but is not limited to, reasonable attorney fees made by any third party which may arise from any
        content a member or user of our site may submit, post, modify, transmit or otherwise make available through our
        Services, the use of Services or your connection with these Services, your violations of the Terms of Service
        and/or your violation of any such rights of another person.
      </p>

      <h4>COMMERCIAL REUSE OF SERVICES</h4>

      <p>
        The member or user herein agrees not to replicate, duplicate, copy, trade, sell, resell nor exploit for any
        commercial reason any part, use of, or access to MakeRocketGoNow LLC's sites.
      </p>

      <h4>MODIFICATIONS</h4>

      <p>
        MakeRocketGoNow LLC shall reserve the right at any time it may deem fit, to modify, alter and or discontinue,
        whether temporarily or permanently, our service, or any part thereof, with or without prior notice. In addition,
        we shall not be held liable to you or to any third party for any such alteration, modification, suspension
        and/or discontinuance of our Services, or any part thereof.
      </p>

      <h4>TERMINATION</h4>

      <p>
        As a member of {'https://pushthat.link'}, you may cancel or terminate your account, associated email address
        and/or access to our Services by submitting a cancellation or termination request to terminate@pushthat.link.
      </p>

      <p>
        As a member, you agree that MakeRocketGoNow LLC may, without any prior written notice, immediately suspend,
        terminate, discontinue and/or limit your account, any email associated with your account, and access to any of
        our Services. The cause for such termination, discontinuance, suspension and/or limitation of access shall
        include, but is not limited to:
      </p>
      <ol>
        <li>any breach or violation of our TOS or any other incorporated agreement, regulation and/or guideline;</li>
        <li>by way of requests from law enforcement or any other governmental agencies;</li>
        <li>the discontinuance, alteration and/or material modification to our Services, or any part thereof;</li>
        <li>unexpected technical or security issues and/or problems; any extended periods of inactivity;</li>
        <li>any engagement by you in any fraudulent or illegal activities; and/or</li>
        <li>
          the nonpayment of any associated fees that may be owed by you in connection with your{' '}
          {'https://pushthat.link'} account Services.
        </li>
      </ol>

      <p>
        Furthermore, you herein agree that any and all terminations, suspensions, discontinuances, and or limitations of
        access for cause shall be made at our sole discretion and that we shall not be liable to you or any other third
        party with regards to the termination of your account, associated email address and/or access to any of our
        Services.
      </p>

      <p>
        The termination of your account with {'https://pushthat.link'} shall include any and/or all of the following:
      </p>
      <ol>
        <li>the removal of any access to all or part of the Services offered within {'https://pushthat.link'};</li>
        <li>
          the deletion of any and all related information, files, and any such content that may be associated with or
          inside your account, or any part thereof; and
        </li>
        <li>the barring of any further use of all or part of our Services.</li>
      </ol>

      <h4>LINKS</h4>

      <p>
        Either MakeRocketGoNow LLC or any third parties may provide links to other websites and/or resources. Thus, you
        acknowledge and agree that we are not responsible for the availability of any such external sites or resources,
        and as such, we do not endorse nor are we responsible or liable for any content, products, advertising or any
        other materials, on or available from such third party sites or resources. Furthermore, you acknowledge and
        agree that MakeRocketGoNow LLC shall not be responsible or liable, directly or indirectly, for any such damage
        or loss which may be a result of, caused or allegedly to be caused by or in connection with the use of or the
        reliance on any such content, goods or Services made available on or through any such site or resource.
      </p>

      <h4>PROPRIETARY</h4>

      <p>
        You do hereby acknowledge and agree that MakeRocketGoNow LLC's Services and any essential software that may be
        used in connection with our Services ("Software") shall contain proprietary and confidential material that is
        protected by applicable intellectual property rights and other laws. Furthermore, you herein acknowledge and
        agree that any Content which may be contained in any advertisements or information presented by and through our
        Services or by advertisers is protected by copyrights, trademarks, patents or other proprietary rights and laws.
        Therefore, except for that which is expressly permitted by applicable law or as authorized by MakeRocketGoNow
        LLC or such applicable licensor, you agree not to alter, modify, lease, rent, loan, sell, distribute, transmit,
        broadcast, publicly perform and/or created any plagiaristic works which are based on MakeRocketGoNow LLC
        Services (e.g. Content or Software), in whole or part.
      </p>

      <p>
        MakeRocketGoNow LLC herein has granted you personal, non-transferable and non-exclusive rights and/or license to
        make use of the object code or our Software, as long as you do not, and shall not, allow any third party to
        duplicate, alter, modify, create or plagiarize work from, reverse engineer, reverse assemble or otherwise make
        an attempt to locate or discern any source code, sell, assign, sublicense, grant a security interest in and/or
        otherwise transfer any such right in the Software. Lastly, you also agree not to access or attempt to access our
        Services through any means other than through the interface which is provided by MakeRocketGoNow LLC for use in
        accessing our Services.
      </p>

      <h4>WARRANTY DISCLAIMERS</h4>

      <p>YOU HEREIN EXPRESSLY ACKNOWLEDGE AND AGREE THAT:</p>

      <ol>
        <li>
          THE USE OF MAKEROCKETGONOW LLC SERVICES AND SOFTWARE ARE AT THE SOLE RISK BY YOU. OUR SERVICES AND SOFTWARE
          SHALL BE PROVIDED ON AN "AS IS" AND/OR "AS AVAILABLE" BASIS. MAKEROCKETGONOW LLC AND OUR SUBSIDIARIES,
          AFFILIATES, OFFICERS, EMPLOYEES, AGENTS, PARTNERS AND LICENSORS EXPRESSLY DISCLAIM ANY AND ALL WARRANTIES OF
          ANY KIND WHETHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO ANY IMPLIED WARRANTIES OF TITLE,
          MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT.
        </li>
        <li>
          MAKEROCKETGONOW LLC AND OUR SUBSIDIARIES, OFFICERS, EMPLOYEES, AGENTS, PARTNERS AND LICENSORS MAKE NO SUCH
          WARRANTIES THAT (i) MAKEROCKETGONOW LLC SERVICES OR SOFTWARE WILL MEET YOUR REQUIREMENTS; (ii) MAKEROCKETGONOW
          LLC SERVICES OR SOFTWARE SHALL BE UNINTERRUPTED, TIMELY, SECURE OR ERROR-FREE; (iii) THAT SUCH RESULTS WHICH
          MAY BE OBTAINED FROM THE USE OF THE MAKEROCKETGONOW LLC SERVICES OR SOFTWARE WILL BE ACCURATE OR RELIABLE;
          (iv) QUALITY OF ANY PRODUCTS, SERVICES, ANY INFORMATION OR OTHER MATERIAL WHICH MAY BE PURCHASED OR OBTAINED
          BY YOU THROUGH OUR SERVICES OR SOFTWARE WILL MEET YOUR EXPECTATIONS; AND (v) THAT ANY SUCH ERRORS CONTAINED IN
          THE SOFTWARE SHALL BE CORRECTED.
        </li>
        <li>
          ANY INFORMATION OR MATERIAL DOWNLOADED OR OTHERWISE OBTAINED BY WAY OF MAKEROCKETGONOW LLC SERVICES OR
          SOFTWARE SHALL BE ACCESSED BY YOUR SOLE DISCRETION AND SOLE RISK, AND AS SUCH YOU SHALL BE SOLELY RESPONSIBLE
          FOR AND HEREBY WAIVE ANY AND ALL CLAIMS AND CAUSES OF ACTION WITH RESPECT TO ANY DAMAGE TO YOUR COMPUTER
          AND/OR INTERNET ACCESS, DOWNLOADING AND/OR DISPLAYING, OR FOR ANY LOSS OF DATA THAT COULD RESULT FROM THE
          DOWNLOAD OF ANY SUCH INFORMATION OR MATERIAL.
        </li>
        <li>
          NO ADVICE AND/OR INFORMATION, DESPITE WHETHER WRITTEN OR ORAL, THAT MAY BE OBTAINED BY YOU FROM
          MAKEROCKETGONOW LLC OR BY WAY OF OR FROM OUR SERVICES OR SOFTWARE SHALL CREATE ANY WARRANTY NOT EXPRESSLY
          STATED IN THE TOS.
        </li>
        <li>
          A SMALL PERCENTAGE OF SOME USERS MAY EXPERIENCE SOME DEGREE OF EPILEPTIC SEIZURE WHEN EXPOSED TO CERTAIN LIGHT
          PATTERNS OR BACKGROUNDS THAT MAY BE CONTAINED ON A COMPUTER SCREEN OR WHILE USING OUR SERVICES. CERTAIN
          CONDITIONS MAY INDUCE A PREVIOUSLY UNKNOWN CONDITION OR UNDETECTED EPILEPTIC SYMPTOM IN USERS WHO HAVE SHOWN
          NO HISTORY OF ANY PRIOR SEIZURE OR EPILEPSY. SHOULD YOU, ANYONE YOU KNOW OR ANYONE IN YOUR FAMILY HAVE AN
          EPILEPTIC CONDITION, PLEASE CONSULT A PHYSICIAN IF YOU EXPERIENCE ANY OF THE FOLLOWING SYMPTOMS WHILE USING
          OUR SERVICES: DIZZINESS, ALTERED VISION, EYE OR MUSCLE TWITCHES, LOSS OF AWARENESS, DISORIENTATION, ANY
          INVOLUNTARY MOVEMENT, OR CONVULSIONS.
        </li>
      </ol>

      <h4>LIMITATION OF LIABILITY</h4>

      <p>
        YOU EXPLICITLY ACKNOWLEDGE, UNDERSTAND AND AGREE THAT MAKEROCKETGONOW LLC AND OUR SUBSIDIARIES, AFFILIATES,
        OFFICERS, EMPLOYEES, AGENTS, PARTNERS AND LICENSORS SHALL NOT BE LIABLE TO YOU FOR ANY PUNITIVE, INDIRECT,
        INCIDENTAL, SPECIAL, CONSEQUENTIAL OR EXEMPLARY DAMAGES, INCLUDING, BUT NOT LIMITED TO, DAMAGES WHICH MAY BE
        RELATED TO THE LOSS OF ANY PROFITS, GOODWILL, USE, DATA AND/OR OTHER INTANGIBLE LOSSES, EVEN THOUGH WE MAY HAVE
        BEEN ADVISED OF SUCH POSSIBILITY THAT SAID DAMAGES MAY OCCUR, AND RESULT FROM:
      </p>
      <ol>
        <li>THE USE OR INABILITY TO USE OUR SERVICE;</li>
        <li>THE COST OF PROCURING SUBSTITUTE GOODS AND SERVICES;</li>
        <li>UNAUTHORIZED ACCESS TO OR THE ALTERATION OF YOUR TRANSMISSIONS AND/OR DATA;</li>
        <li>STATEMENTS OR CONDUCT OF ANY SUCH THIRD PARTY ON OUR SERVICE;</li>
        <li>AND ANY OTHER MATTER WHICH MAY BE RELATED TO OUR SERVICE.</li>
      </ol>

      <h4>RELEASE</h4>

      <p>
        In the event you have a dispute, you agree to release MakeRocketGoNow LLC (and its officers, directors,
        employees, agents, parent subsidiaries, affiliates, co-branders, partners and any other third parties) from
        claims, demands and damages (actual and consequential) of every kind and nature, known and unknown, suspected or
        unsuspected, disclosed and undisclosed, arising out of or in any way connected to such dispute.
      </p>

      <h4>EXCLUSION AND LIMITATIONS</h4>

      <p>
        THERE ARE SOME JURISDICTIONS WHICH DO NOT ALLOW THE EXCLUSION OF CERTAIN WARRANTIES OR THE LIMITATION OF
        EXCLUSION OF LIABILITY FOR INCIDENTAL OR CONSEQUENTIAL DAMAGES. THEREFORE, SOME OF THE ABOVE LIMITATIONS OF
        SECTIONS WARRANTY DISCLAIMERS AND LIMITATION OF LIABILITY MAY NOT APPLY TO YOU.
      </p>

      <h4>THIRD PARTY BENEFICIARIES</h4>

      <p>
        You herein acknowledge, understand and agree, unless otherwise expressly provided in this TOS, that there shall
        be no third-party beneficiaries to this agreement.
      </p>

      <h4>NOTICE</h4>

      <p>
        MakeRocketGoNow LLC may furnish you with notices, including those with regards to any changes to the TOS,
        including but not limited to email, regular mail, MMS or SMS, text messaging, postings on our website Services,
        or other reasonable means currently known or any which may be herein after developed. Any such notices may not
        be received if you violate any aspects of the TOS by accessing our Services in an unauthorized manner. Your
        acceptance of this TOS constitutes your agreement that you are deemed to have received any and all notices that
        would have been delivered had you accessed our Services in an authorized manner.
      </p>

      <h4>TRADEMARK INFORMATION</h4>

      <p>
        You herein acknowledge, understand and agree that all of the MakeRocketGoNow LLC and PushThat trademarks,
        copyright, trade name, service marks, and other MakeRocketGoNow LLC and PushThat logos and any brand features,
        and/or product and service names are trademarks and as such, are and shall remain the property of
        MakeRocketGoNow LLC. You herein agree not to display and/or use in any manner the MakeRocketGoNow LLC or
        PushThat logo or marks without obtaining MakeRocketGoNow LLC's prior written consent.
      </p>

      <h4>GENERAL INFORMATION</h4>

      <h5>ENTIRE AGREEMENT</h5>

      <p>
        This TOS constitutes the entire agreement between you and MakeRocketGoNow LLC and shall govern the use of our
        Services, superseding any prior version of this TOS between you and us with respect to MakeRocketGoNow LLC
        Services. You may also be subject to additional terms and conditions that may apply when you use or purchase
        certain other MakeRocketGoNow LLC Services, affiliate Services, third-party content or third-party software.
      </p>

      <h5>CHOICE OF LAW AND FORUM</h5>

      <p>
        It is at the mutual agreement of both you and MakeRocketGoNow LLC with regard to the TOS that the relationship
        between the parties shall be governed by the laws of the state of Minnesota without regard to its conflict of
        law provisions and that any and all claims, causes of action and/or disputes, arising out of or relating to the
        TOS, or the relationship between you and MakeRocketGoNow LLC, shall be filed within the courts having
        jurisdiction within the County of Dakota, Minnesota or the U.S. District Court located in said state. You and
        MakeRocketGoNow LLC agree to submit to the jurisdiction of the courts as previously mentioned, and agree to
        waive any and all objections to the exercise of jurisdiction over the parties by such courts and to venue in
        such courts.
      </p>

      <h5>WAIVER AND SEVERABILITY OF TERM</h5>

      <p>
        At any time, should MakeRocketGoNow LLC fail to exercise or enforce any right or provision of the TOS, such
        failure shall not constitute a waiver of such right or provision. If any provision of this TOS is found by a
        court of competent jurisdiction to be invalid, the parties nevertheless agree that the court should endeavor to
        give effect to the parties' intentions as reflected in the provision, and the other provisions of the TOS remain
        in full force and effect.
      </p>

      <h5>NO RIGHT OF SURVIVORSHIP NON-TRANSFERABILITY</h5>

      <p>
        You acknowledge, understand and agree that your account is non-transferable and any rights to your ID and/or
        contents within your account shall terminate upon your death. Upon receipt of a copy of a death certificate,
        your account may be terminated and all contents therein permanently deleted.
      </p>

      <h5>STATUTE OF LIMITATIONS</h5>

      <p>
        You acknowledge, understand and agree that regardless of any statute or law to the contrary, any claim or action
        arising out of or related to the use of our Services or the TOS must be filed within 60 days after said claim or
        cause of action arose or shall be forever barred.
      </p>

      <h5>VIOLATIONS</h5>

      <p>Please report any and all violations of this TOS to MakeRocketGoNow LLC as follows:</p>

      <p>Email: violations@pushthat.link</p>
    </LegalContainer>
  );
}
